import type { NextApiRequest, NextApiResponse } from 'next'

type PricingResult = {
  region: string
  price_mwh: number
}

type ErrorResult = {
  error: string
}

// GridStatus.io real-time LMP/SPP. One representative LOAD-side location per
// region (consumption price, apples-to-apples for a data center):
//   CAISO  -> PG&E default load aggregation point (San Jose / PG&E north)
//   PJM    -> Dominion zone (Ashburn / "Data Center Alley")
//   ERCOT  -> Austin Energy load zone (Austin)
// ERCOT reports settlement-point price in `spp`; CAISO/PJM report `lmp`.
const REGIONS = [
  { region: 'CAISO', dataset: 'caiso_lmp_real_time_5_min',  location: 'DLAP_PGAE-APND', priceField: 'lmp', fallback: 45.50 },
  { region: 'PJM',   dataset: 'pjm_lmp_real_time_5_min',    location: 'DOM',            priceField: 'lmp', fallback: 52.30 },
  { region: 'ERCOT', dataset: 'ercot_spp_real_time_15_min', location: 'LZ_AEN',         priceField: 'spp', fallback: 38.20 },
]

const API_BASE   = 'https://api.gridstatus.io/v1/datasets'
const WINDOW_MS   = 60 * 60 * 1000   // 1h lookback — keeps row count < limit
const ROW_LIMIT   = 50               // must exceed intervals-in-window (12 @ 5min)
const RATE_GAP_MS = 1100             // free tier: 1 request / second
const REQ_TIMEOUT = 5000             // per-call; tolerant of transient GridStatus latency
const CACHE_TTL   = 60 * 1000        // real-time prices update every 5-15 min

// Vercel: cache-miss path is ~3 sequential calls + spacing
export const config = { maxDuration: 15 }

let cache: { ts: number; data: PricingResult[] } | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchLatestPrice(
  dataset: string,
  location: string,
  priceField: string
): Promise<number> {
  const start = new Date(Date.now() - WINDOW_MS).toISOString()
  const url = new URL(`${API_BASE}/${dataset}/query`)
  url.searchParams.set('filter_column', 'location')
  url.searchParams.set('filter_value', location)
  url.searchParams.set('start_time', start)
  url.searchParams.set('limit', String(ROW_LIMIT))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT)

  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'x-api-key': process.env.GRIDSTATUS_API_KEY ?? '' },
    })
    if (!res.ok) throw new Error(`GridStatus ${res.status}`)
    const json = await res.json()
    const rows: Record<string, unknown>[] = json?.data ?? []
    if (!rows.length) throw new Error('No rows in window')

    // Rows come back ascending by time; if the window ever overflows `limit`
    // the NEWEST rows are dropped — surface that rather than serve a stale price.
    if (json?.meta?.hasNextPage) {
      console.warn(`[/api/pricing] window truncated for ${location} — widen limit`)
    }

    // Take the most recent interval explicitly (don't trust ordering)
    const latest = rows.reduce((a, b) =>
      String(a.interval_start_utc) > String(b.interval_start_utc) ? a : b
    )
    const price = latest[priceField]
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      throw new Error(`Missing ${priceField} in latest row`)
    }
    return price
  } finally {
    clearTimeout(timer)
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PricingResult[] | ErrorResult>
) {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    res.status(200).json(cache.data)
    return
  }

  // Sequential (not parallel) to respect the 1 req/sec free-tier rate limit
  const results: PricingResult[] = []
  let allLive = true
  for (let i = 0; i < REGIONS.length; i++) {
    const { region, dataset, location, priceField, fallback } = REGIONS[i]
    try {
      const price_mwh = await fetchLatestPrice(dataset, location, priceField)
      results.push({ region, price_mwh: Math.round(price_mwh * 100) / 100 })
    } catch (err) {
      console.error(`[/api/pricing] region=${region}`, err)
      results.push({ region, price_mwh: fallback })
      allLive = false
    }
    if (i < REGIONS.length - 1) await sleep(RATE_GAP_MS)
  }

  // Only cache a fully-live result — never pin a transient fallback for 60s
  if (allLive) cache = { ts: Date.now(), data: results }
  res.status(200).json(results)
}
