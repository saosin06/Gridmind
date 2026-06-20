import type { NextApiRequest, NextApiResponse } from 'next'
import { getPricing, type PriceRow } from '../../lib/gridmind/data'

// Vercel: cache-miss path is ~3 sequential GridStatus calls + spacing
export const config = { maxDuration: 15 }

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<PriceRow[]>
) {
  res.status(200).json(await getPricing())
}
