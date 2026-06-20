// Workload economics + carbon time-shift. Pure functions over already-fetched data.

import type { ForecastPoint } from './data'

export type CostEstimate = { facility_mwh: number; cost: number; co2_tonnes: number }

/**
 * Energy cost + emissions for a workload.
 * facility MWh = IT load (MW) × hours × PUE.  cost = MWh × $/MWh.
 * CO2 (t) = MWh × gCO2/kWh / 1000.  Negative price → negative cost (grid revenue).
 */
export function estimateCost(
  region: { price: number; pue: number; carbon: number },
  mw: number,
  hours: number
): CostEstimate {
  const facility_mwh = mw * hours * region.pue
  return {
    facility_mwh,
    cost: facility_mwh * region.price,
    co2_tonnes: (facility_mwh * region.carbon) / 1000,
  }
}

export type TimeShift = { hours_away: number; carbon: number; pct_drop: number } | null

/**
 * Cleanest upcoming hour vs. now. Returns null if waiting saves < `minPct`%.
 * `now` is passed in (callers stamp it) so this stays pure/testable.
 */
export function bestTimeToRun(
  forecast: ForecastPoint[],
  currentCarbon: number,
  nowMs: number,
  minPct = 15
): TimeShift {
  if (!forecast.length || currentCarbon <= 0) return null
  const min = forecast.reduce((a, b) => (b.carbon < a.carbon ? b : a))
  const pct = Math.round(((currentCarbon - min.carbon) / currentCarbon) * 100)
  if (pct < minPct) return null
  const hoursAway = Math.max(1, Math.round((new Date(min.datetime).getTime() - nowMs) / 3_600_000))
  return { hours_away: hoursAway, carbon: min.carbon, pct_drop: pct }
}
