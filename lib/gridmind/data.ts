// Server-side data fetchers for live grid conditions. These talk to the external
// APIs directly (no internal HTTP fan-out) so the API routes, /api/decide, and the
// MCP server can all share one implementation + cache.

import { REGIONS } from './regions'

export type WeatherRow = { region: string; temp_f: number; humidity: number; dew_point: number }
export type CarbonRow = { zone: string; carbon_intensity: number }
export type PriceRow = { region: string; price_mwh: number }
export type ForecastPoint = { datetime: string; carbon: number }
export type RegionForecast = { region: string; zone: string; forecast: ForecastPoint[] }
export type RegionData = { name: string; price: number; pue: number; base_pue: number; temp_f: number; carbon: number }

// ── Weather (OpenWeatherMap) ──────────────────────────────────────────
async function fetchWeatherAt(lat: number, lon: number): Promise<{ temp_c: number; humidity: number }> {
  const url = new URL('https://api.openweathermap.org/data/2.5/weather')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lon))
  url.searchParams.set('appid', process.env.OPENWEATHERMAP_API_KEY ?? '')
  url.searchParams.set('units', 'metric')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(url.toString(), { signal: controller.signal })
    if (!res.ok) throw new Error(`OpenWeatherMap ${res.status}`)
    const data = await res.json()
    return { temp_c: data.main.temp as number, humidity: data.main.humidity as number }
  } finally {
    clearTimeout(timer)
  }
}

const dewPoint = (tempC: number, humidity: number) => {
  const a = 17.27, b = 237.7
  const alpha = (a * tempC) / (b + tempC) + Math.log(humidity / 100)
  return (b * alpha) / (a - alpha)
}
const toF = (c: number) => (c * 9) / 5 + 32

export async function getWeather(): Promise<WeatherRow[]> {
  return Promise.all(
    REGIONS.map(async (r) => {
      const { temp_c, humidity } = await fetchWeatherAt(r.lat, r.lon)
      return {
        region: r.name,
        temp_f: Math.round(toF(temp_c) * 10) / 10,
        humidity,
        dew_point: Math.round(toF(dewPoint(temp_c, humidity)) * 10) / 10,
      }
    })
  )
}

// ── Carbon intensity (Electricity Maps) ───────────────────────────────
async function fetchZoneIntensity(zone: string): Promise<number> {
  const url = new URL('https://api-access.electricitymaps.com/free-tier/carbon-intensity/latest')
  url.searchParams.set('zone', zone)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'auth-token': process.env.ELECTRICITY_MAPS_AUTH_TOKEN ?? '' },
    })
    if (!res.ok) throw new Error(`Electricity Maps ${res.status}`)
    const data = await res.json()
    const intensity = data?.carbonIntensity
    if (typeof intensity !== 'number' || !Number.isFinite(intensity)) {
      throw new Error('Missing carbonIntensity in response')
    }
    return intensity
  } finally {
    clearTimeout(timer)
  }
}

export async function getCarbon(): Promise<CarbonRow[]> {
  return Promise.all(
    REGIONS.map(async (r) => {
      try {
        return { zone: r.carbonZone, carbon_intensity: await fetchZoneIntensity(r.carbonZone) }
      } catch (err) {
        console.error(`[data.getCarbon] zone=${r.carbonZone}`, err)
        return { zone: r.carbonZone, carbon_intensity: r.carbonFallback }
      }
    })
  )
}

// ── Pricing (GridStatus real-time LMP/SPP) ────────────────────────────
const GS_BASE = 'https://api.gridstatus.io/v1/datasets'
const GS_WINDOW_MS = 60 * 60 * 1000
const GS_ROW_LIMIT = 50
const GS_RATE_GAP_MS = 1100   // free tier: 1 req/sec
const GS_TIMEOUT = 5000
const PRICE_CACHE_TTL = 60 * 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let priceCache: { ts: number; data: PriceRow[] } | null = null

async function fetchLatestPrice(dataset: string, location: string, priceField: string): Promise<number> {
  const start = new Date(Date.now() - GS_WINDOW_MS).toISOString()
  const url = new URL(`${GS_BASE}/${dataset}/query`)
  url.searchParams.set('filter_column', 'location')
  url.searchParams.set('filter_value', location)
  url.searchParams.set('start_time', start)
  url.searchParams.set('limit', String(GS_ROW_LIMIT))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GS_TIMEOUT)
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'x-api-key': process.env.GRIDSTATUS_API_KEY ?? '' },
    })
    if (!res.ok) throw new Error(`GridStatus ${res.status}`)
    const json = await res.json()
    const rows: Record<string, unknown>[] = json?.data ?? []
    if (!rows.length) throw new Error('No rows in window')
    if (json?.meta?.hasNextPage) console.warn(`[data.getPricing] window truncated for ${location}`)
    const latest = rows.reduce((a, b) =>
      String(a.interval_start_utc) > String(b.interval_start_utc) ? a : b
    )
    const price = latest[priceField]
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      throw new Error(`Missing ${priceField} in latest row`)
    }
    return price
  } finally {
    clearTimeout(timer)
  }
}

export async function getPricing(): Promise<PriceRow[]> {
  if (priceCache && Date.now() - priceCache.ts < PRICE_CACHE_TTL) return priceCache.data

  const results: PriceRow[] = []
  let allLive = true
  for (let i = 0; i < REGIONS.length; i++) {
    const r = REGIONS[i]
    try {
      const price = await fetchLatestPrice(r.pricingDataset, r.pricingLocation, r.pricingField)
      results.push({ region: r.pricingKey, price_mwh: Math.round(price * 100) / 100 })
    } catch (err) {
      console.error(`[data.getPricing] region=${r.pricingKey}`, err)
      results.push({ region: r.pricingKey, price_mwh: r.pricingFallback })
      allLive = false
    }
    if (i < REGIONS.length - 1) await sleep(GS_RATE_GAP_MS)
  }
  if (allLive) priceCache = { ts: Date.now(), data: results }
  return results
}

// ── Carbon forecast (Electricity Maps) ────────────────────────────────
const FORECAST_CACHE_TTL = 20 * 60 * 1000
let forecastCache: { ts: number; data: RegionForecast[] } | null = null

async function fetchForecast(zone: string): Promise<ForecastPoint[]> {
  const url = new URL('https://api-access.electricitymaps.com/free-tier/carbon-intensity/forecast')
  url.searchParams.set('zone', zone)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'auth-token': process.env.ELECTRICITY_MAPS_AUTH_TOKEN ?? '' },
    })
    if (!res.ok) throw new Error(`Electricity Maps ${res.status}`)
    const data = await res.json()
    const rows: { carbonIntensity: number; datetime: string }[] = data?.forecast ?? []
    return rows
      .filter((r) => typeof r.carbonIntensity === 'number')
      .slice(0, 24)
      .map((r) => ({ datetime: r.datetime, carbon: r.carbonIntensity }))
  } finally {
    clearTimeout(timer)
  }
}

export async function getForecast(): Promise<RegionForecast[]> {
  if (forecastCache && Date.now() - forecastCache.ts < FORECAST_CACHE_TTL) return forecastCache.data
  const data = await Promise.all(
    REGIONS.map(async (r) => {
      try {
        return { region: r.name, zone: r.carbonZone, forecast: await fetchForecast(r.carbonZone) }
      } catch (err) {
        console.error(`[data.getForecast] zone=${r.carbonZone}`, err)
        return { region: r.name, zone: r.carbonZone, forecast: [] as ForecastPoint[] }
      }
    })
  )
  if (data.some((d) => d.forecast.length)) forecastCache = { ts: Date.now(), data }
  return data
}

// ── Dynamic cooling: ambient temperature → effective PUE ──────────────
// Cooling efficiency is thermodynamically tied to ambient temperature. Below the
// free-cooling threshold a facility runs at its base PUE; above it, cooling load
// (and thus PUE) climbs roughly linearly with temperature.
const FREE_COOLING_C = 15
const COOLING_FACTOR = 0.012 // PUE added per °C above the threshold
export function effectivePue(basePue: number, tempC: number): number {
  return Math.round((basePue + COOLING_FACTOR * Math.max(0, tempC - FREE_COOLING_C)) * 100) / 100
}

// ── Aggregate: live price + carbon + temperature-adjusted PUE per region ──
export async function getRegions(): Promise<RegionData[]> {
  const [carbonSettled, pricingSettled, weatherSettled] = await Promise.allSettled([
    getCarbon(), getPricing(), getWeather(),
  ])
  const carbon: CarbonRow[] = carbonSettled.status === 'fulfilled' ? carbonSettled.value : []
  const pricing: PriceRow[] = pricingSettled.status === 'fulfilled' ? pricingSettled.value : []
  const weather: WeatherRow[] = weatherSettled.status === 'fulfilled' ? weatherSettled.value : []

  return REGIONS.map((r) => {
    const tempF = weather.find((w) => w.region === r.name)?.temp_f
    const pue = tempF != null ? effectivePue(r.pue, ((tempF - 32) * 5) / 9) : r.pue
    return {
      name: r.name,
      price: pricing.find((p) => p.region === r.pricingKey)?.price_mwh ?? r.pricingFallback,
      pue,
      base_pue: r.pue,
      temp_f: tempF ?? 0,
      carbon: carbon.find((c) => c.zone === r.carbonZone)?.carbon_intensity ?? r.carbonFallback,
    }
  })
}
