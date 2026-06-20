import type { NextApiRequest, NextApiResponse } from 'next'

type WeatherResult = {
  region: string
  temp_f: number
  humidity: number
  dew_point: number
}

type ErrorResult = {
  error: string
}

const LOCATIONS = [
  { region: 'San Jose',  lat: 37.3382, lon: -121.8863 },
  { region: 'Ashburn',   lat: 38.9940, lon:  -77.4897 },
  { region: 'Austin',    lat: 30.2672, lon:  -97.7431 },
]

async function fetchWeather(lat: number, lon: number): Promise<{ temp_c: number; humidity: number }> {
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

// Magnus formula approximation
function dewPoint(temp_c: number, humidity: number): number {
  const a = 17.27
  const b = 237.7
  const alpha = (a * temp_c) / (b + temp_c) + Math.log(humidity / 100)
  return (b * alpha) / (a - alpha)
}

function toFahrenheit(c: number): number {
  return c * 9 / 5 + 32
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<WeatherResult[] | ErrorResult>
) {
  try {
    const results = await Promise.all(
      LOCATIONS.map(async (loc) => {
        const { temp_c, humidity } = await fetchWeather(loc.lat, loc.lon)
        const dp_c = dewPoint(temp_c, humidity)
        return {
          region:    loc.region,
          temp_f:    Math.round(toFahrenheit(temp_c) * 10) / 10,
          humidity,
          dew_point: Math.round(toFahrenheit(dp_c) * 10) / 10,
        }
      })
    )
    res.status(200).json(results)
  } catch (err) {
    console.error('[/api/weather]', err)
    res.status(502).json({ error: 'Failed to fetch weather data' })
  }
}
