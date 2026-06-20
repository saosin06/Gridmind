import type { NextApiRequest, NextApiResponse } from 'next'
import { rankRegions, type Weights, type ScoredRegion } from '../../lib/gridmind/scoring'

type RouteResponse = {
  recommendation: string
  top3: ScoredRegion[]
  scores: { region: string; score: number }[]
}
type ErrorResult = { error: string }

// Scoring runs in JS (the C++/WASM build powers the client-side speed telemetry;
// Node can't load the browser WASM artifact). See lib/gridmind/scoring.ts.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RouteResponse | ErrorResult>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { regions, alpha, beta, gamma, delta } = req.body as {
    regions: (ScoredRegion & { latency?: number })[]
    alpha: number; beta: number; gamma: number; delta: number
  }

  if (!Array.isArray(regions) || !regions.length) {
    res.status(400).json({ error: 'regions must be a non-empty array' })
    return
  }

  const w: Weights = { alpha: alpha ?? 0, beta: beta ?? 0, gamma: gamma ?? 0, delta: delta ?? 0 }
  const ranked = rankRegions(regions, w)

  res.status(200).json({
    recommendation: ranked[0]?.name ?? '',
    top3:           ranked.slice(0, 3),
    scores:         ranked.map((r) => ({ region: r.name, score: r.composite_score })),
  })
}
