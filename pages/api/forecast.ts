import type { NextApiRequest, NextApiResponse } from 'next'
import { getForecast, type RegionForecast } from '../../lib/gridmind/data'

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<RegionForecast[]>
) {
  res.status(200).json(await getForecast())
}
