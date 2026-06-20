import type { NextApiRequest, NextApiResponse } from 'next'
import { getWeather, type WeatherRow } from '../../lib/gridmind/data'

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<WeatherRow[] | { error: string }>
) {
  try {
    res.status(200).json(await getWeather())
  } catch (err) {
    console.error('[/api/weather]', err)
    res.status(502).json({ error: 'Failed to fetch weather data' })
  }
}
