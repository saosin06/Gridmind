import type { NextApiRequest, NextApiResponse } from 'next'
import { getCarbon, type CarbonRow } from '../../lib/gridmind/data'

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<CarbonRow[]>
) {
  res.status(200).json(await getCarbon())
}
