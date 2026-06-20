import type { NextApiRequest, NextApiResponse } from 'next'

type CloudRegion = {
  name: string
  price: number
  pue: number
  carbon: number
  latency?: number
  composite_score: number
}

type RouteResponse = {
  recommendation: string
  top3: CloudRegion[]
  scores: { region: string; score: number }[]
}

type ErrorResult = { error: string }

// Each factor is normalized to a comparable ~0..1 range before weighting —
// otherwise carbon (hundreds) swamps price (tens), PUE (~1.5) and latency (ms)
// regardless of the weights, and the sliders/presets wouldn't change the
// ranking. Divide by a representative scale; ×100 keeps scores readable.
// Lower composite = better region.
// (Scoring runs in JS here; the C++/WASM build powers the client-side speed
// telemetry — Node can't load the browser WASM artifact.)
const NORM = { price: 100, pue: 2, carbon: 500, latency: 100 }

function score(r: CloudRegion, a: number, b: number, g: number, d: number): number {
  const s =
    a * (r.price / NORM.price) +
    b * (r.pue / NORM.pue) +
    g * (r.carbon / NORM.carbon) +
    d * ((r.latency ?? 0) / NORM.latency)
  return Math.round(s * 100 * 100) / 100
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RouteResponse | ErrorResult>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { regions, alpha, beta, gamma, delta } = req.body as {
    regions: CloudRegion[]
    alpha: number
    beta: number
    gamma: number
    delta: number
  }

  if (!Array.isArray(regions) || !regions.length) {
    res.status(400).json({ error: 'regions must be a non-empty array' })
    return
  }

  const a = alpha ?? 0, b = beta ?? 0, g = gamma ?? 0, d = delta ?? 0
  const ranked = regions
    .map((r) => ({ ...r, composite_score: score(r, a, b, g, d) }))
    .sort((x, y) => x.composite_score - y.composite_score)

  res.status(200).json({
    recommendation: ranked[0]?.name ?? '',
    top3:           ranked.slice(0, 3),
    scores:         ranked.map((r) => ({ region: r.name, score: r.composite_score })),
  })
}
