import type { NextApiRequest, NextApiResponse } from 'next'
import { getWeather, type WeatherRow } from '../../lib/gridmind/data'

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<WeatherRow[] | { error: string }>
) {
  try {
    const data = await getWeather()
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800')
    res.status(200).json(data)
  } catch (err) {
    console.error('[/api/weather]', err)
    res.status(502).json({ error: 'Failed to fetch weather data' })
  }
}
