import type { NextApiRequest, NextApiResponse } from 'next'
import path from 'path'

type CloudRegion = {
  name: string
  price: number
  pue: number
  carbon: number
  composite_score: number
}

type RouteResponse = {
  recommendation: string
  top3: CloudRegion[]
  scores: { region: string; score: number }[]
}

type ErrorResult = {
  error: string
}

// Cache the initialized WASM module across requests
let wasmModule: any = null

async function getModule(): Promise<any> {
  if (wasmModule) return wasmModule
  // require() path must be absolute on the filesystem — /public/scorer.js resolves
  // to <cwd>/public/scorer.js, not the filesystem root
  const scorerPath = path.join(process.cwd(), 'public', 'scorer.js')
  // Indirect require: prevents Turbopack from statically resolving (and trying to
  // bundle) the Emscripten glue at build time. It's loaded from disk at runtime,
  // so a missing/uncompiled scorer.js falls through to the caller's JS fallback.
  // eslint-disable-next-line no-eval
  const nodeRequire = (0, eval)('require') as NodeRequire
  const factory = nodeRequire(scorerPath)
  wasmModule = await factory()
  return wasmModule
}

function rankWithWasm(
  m: any,
  regions: CloudRegion[],
  alpha: number,
  beta: number,
  gamma: number
): CloudRegion[] {
  const matcher = new m.GridMatcher()
  const vec = new m.VectorCloudRegion()

  try {
    for (const r of regions) vec.push_back(r)
    const result = matcher.rank_regions(vec, alpha, beta, gamma)

    const ranked: CloudRegion[] = []
    for (let i = 0; i < result.size(); i++) ranked.push(result.get(i))
    result.delete()
    return ranked
  } finally {
    vec.delete()
    matcher.delete()
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RouteResponse | ErrorResult>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { regions, alpha, beta, gamma } = req.body as {
    regions: CloudRegion[]
    alpha: number
    beta: number
    gamma: number
  }

  if (!Array.isArray(regions) || !regions.length) {
    res.status(400).json({ error: 'regions must be a non-empty array' })
    return
  }

  let ranked: CloudRegion[]

  try {
    const m = await getModule()
    ranked = rankWithWasm(m, regions, alpha ?? 1, beta ?? 1, gamma ?? 1)
  } catch (err) {
    console.error('[/api/route] WASM error', err)
    // Fallback: sort by composite_score using the JS formula directly
    const a = alpha ?? 1, b = beta ?? 1, g = gamma ?? 1
    ranked = regions
      .map((r) => ({ ...r, composite_score: a * r.price + b * r.pue + g * r.carbon }))
      .sort((x, y) => x.composite_score - y.composite_score)
  }

  res.status(200).json({
    recommendation: ranked[0]?.name ?? '',
    top3:           ranked.slice(0, 3),
    scores:         ranked.map((r) => ({ region: r.name, score: r.composite_score })),
  })
}
