import type { NextApiRequest, NextApiResponse } from 'next'

type ForecastPoint = { datetime: string; carbon: number }
type RegionForecast = { region: string; zone: string; forecast: ForecastPoint[] }
type ErrorResult = { error: string }

// region -> Electricity Maps zone (same mapping as carbon/aggregate)
const ZONES = [
  { region: 'San Jose', zone: 'US-CAL-CISO' },
  { region: 'Ashburn',  zone: 'US-MIDA-PJM' },
  { region: 'Austin',   zone: 'US-TEX-ERCO' },
]

const CACHE_TTL = 20 * 60 * 1000 // forecast only moves hourly; ease the call cap
let cache: { ts: number; data: RegionForecast[] } | null = null

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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RegionForecast[] | ErrorResult>
) {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    res.status(200).json(cache.data)
    return
  }

  const data = await Promise.all(
    ZONES.map(async ({ region, zone }) => {
      try {
        return { region, zone, forecast: await fetchForecast(zone) }
      } catch (err) {
        console.error(`[/api/forecast] zone=${zone}`, err)
        return { region, zone, forecast: [] }
      }
    })
  )

  // only cache if at least one region returned data
  if (data.some((d) => d.forecast.length)) cache = { ts: Date.now(), data }
  res.status(200).json(data)
}
