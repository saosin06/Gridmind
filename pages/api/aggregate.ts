import type { NextApiRequest, NextApiResponse } from 'next'
import { getRegions } from '../../lib/gridmind/data'

type CloudRegion = {
  name: string
  price: number
  pue: number
  carbon: number
  composite_score: number
}

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<CloudRegion[]>
) {
  const regions = await getRegions()
  // composite_score is filled in by /api/route once weights are known
  res.status(200).json(regions.map((r) => ({ ...r, composite_score: 0 })))
}
