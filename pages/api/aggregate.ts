import type { NextApiRequest, NextApiResponse } from 'next'
import { getRegions } from '../../lib/gridmind/data'

// getRegions() runs 3 sequential GridStatus calls (1 req/sec rate limit) +
// Electricity Maps — needs headroom beyond Vercel's 10s default or pricing
// times out and falls back to constants. (Edge-cached, so this only runs on
// background revalidation, not on the user's request.)
export const config = { maxDuration: 30 }

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
  // Edge-cache: serve instantly + refresh in the background (prices move every 5-15 min)
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600')
  // composite_score is filled in by /api/score once weights are known
  res.status(200).json(regions.map((r) => ({ ...r, composite_score: 0 })))
}
