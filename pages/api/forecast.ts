import type { NextApiRequest, NextApiResponse } from 'next'
import { getForecast, type RegionForecast } from '../../lib/gridmind/data'

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<RegionForecast[]>
) {
  const data = await getForecast()
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600')
  res.status(200).json(data)
}
