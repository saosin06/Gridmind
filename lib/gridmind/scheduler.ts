// Fast, deterministic batch router for the autonomous fleet scheduler. This runs
// in the hot loop (every tick), so it must be cheap + instant — no LLM calls.
// The LLM agent (/api/decide) is reserved for deep single-job analysis and
// operator briefings, not per-job routing at scale.

import { withLatency, rankRegions, PRESETS, DEFAULT_WEIGHTS } from './scoring'
import { estimateCost, bestTimeToRun } from './economics'
import type { RegionData, RegionForecast } from './data'

export type Policy = { allowed_regions?: string[]; max_latency_ms?: number; max_carbon?: number }

export type JobInput = {
  id: string
  mw: number
  hours: number
  flexible: boolean
  profile?: string // PRESETS key
}

export type JobPlan = {
  id: string
  region: string
  run_now: boolean
  defer_hours: number
  cost: number
  co2_tonnes: number
  savings_usd: number
  savings_co2: number
  baseline_region: string
  reason: string
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d

function passesPolicy(r: { name: string; latency: number; carbon: number }, p: Policy): boolean {
  if (p.allowed_regions && !p.allowed_regions.includes(r.name)) return false
  if (p.max_latency_ms != null && r.latency > p.max_latency_ms) return false
  if (p.max_carbon != null && r.carbon > p.max_carbon) return false
  return true
}

/** Route a batch of jobs against one live snapshot. Pure + synchronous. */
export function planJobs(
  jobs: JobInput[],
  regions: RegionData[],
  forecasts: RegionForecast[],
  policy: Policy,
  userLoc: string,
  nowMs: number
): JobPlan[] {
  const withLat = withLatency(regions, userLoc)
  const worstAll = [...rankRegions(withLat, DEFAULT_WEIGHTS)].sort((a, b) => b.composite_score - a.composite_score)[0]

  return jobs.map((job) => {
    const weights = (job.profile && PRESETS[job.profile]) || DEFAULT_WEIGHTS
    const ranked = rankRegions(withLat, weights)
    const candidates = ranked.filter((r) => passesPolicy(r, policy))
    const chosen = candidates[0] ?? ranked[0]

    // timing: flexible jobs may defer to a cleaner forecast hour
    let deferHours = 0
    let reason = `lowest ${dominantFactor(weights)} score`
    if (job.flexible) {
      const fc = forecasts.find((f) => f.region === chosen.name)?.forecast ?? []
      const ts = bestTimeToRun(fc, chosen.carbon, nowMs, 15)
      if (ts) { deferHours = ts.hours_away; reason += `; deferred ${ts.hours_away}h for ${ts.pct_drop}% cleaner grid` }
    }
    const runNow = deferHours === 0

    const fc = forecasts.find((f) => f.region === chosen.name)?.forecast ?? []
    const carbon = runNow ? chosen.carbon : (fc[Math.min(fc.length - 1, deferHours - 1)]?.carbon ?? chosen.carbon)
    const econ = estimateCost({ ...chosen, carbon }, job.mw, job.hours)
    const worstEcon = estimateCost(worstAll, job.mw, job.hours)

    return {
      id: job.id,
      region: chosen.name,
      run_now: runNow,
      defer_hours: deferHours,
      cost: round(econ.cost),
      co2_tonnes: round(econ.co2_tonnes, 2),
      savings_usd: round(worstEcon.cost - econ.cost),
      savings_co2: round(worstEcon.co2_tonnes - econ.co2_tonnes, 2),
      baseline_region: worstAll.name,
      reason,
    }
  })
}

function dominantFactor(w: { alpha: number; beta: number; gamma: number; delta: number }): string {
  const entries: [string, number][] = [['cost', w.alpha], ['efficiency', w.beta], ['carbon', w.gamma], ['latency', w.delta]]
  return entries.sort((a, b) => b[1] - a[1])[0][0]
}
