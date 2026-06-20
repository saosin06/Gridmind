// Scoring + latency. Each factor is normalized to a comparable ~0..1 range before
// weighting (otherwise carbon swamps everything); ×100 for readable scores.
// Lower composite = better region.

import { REGIONS, USER_LOCATIONS, regionByName } from './regions'
import type { RegionData } from './data'

export type Weights = { alpha: number; beta: number; gamma: number; delta: number }
export type ScoredRegion = RegionData & { latency: number; composite_score: number }

export const NORM = { price: 100, pue: 2, carbon: 500, latency: 100 }

export const PRESETS: Record<string, Weights> = {
  training:  { alpha: 0.25, beta: 0.10, gamma: 0.60, delta: 0.05 }, // carbon-first
  inference: { alpha: 0.15, beta: 0.20, gamma: 0.15, delta: 0.50 }, // latency-first
  batch:     { alpha: 0.60, beta: 0.15, gamma: 0.20, delta: 0.05 }, // cost-first
  balanced:  { alpha: 0.30, beta: 0.20, gamma: 0.25, delta: 0.25 },
}
export const DEFAULT_WEIGHTS: Weights = PRESETS.balanced

// ── Latency: haversine distance → RTT estimate ────────────────────────
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const la1 = a.lat * rad, la2 = b.lat * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
// ~200 km/ms in fiber, ×2 round-trip, ×1.4 path inflation, +5ms base
const estLatency = (distKm: number) => Math.round((distKm / 200) * 2 * 1.4 + 5)

export function latencyFor(regionName: string, userLocKey: string): number {
  const dc = regionByName(regionName)
  const u = USER_LOCATIONS.find((l) => l.key === userLocKey)
  return dc && u ? estLatency(haversineKm(u, dc)) : 0
}

export function withLatency(regions: RegionData[], userLocKey: string): (RegionData & { latency: number })[] {
  return regions.map((r) => ({ ...r, latency: latencyFor(r.name, userLocKey) }))
}

// ── Scoring ───────────────────────────────────────────────────────────
export function scoreRegion(r: { price: number; pue: number; carbon: number; latency?: number }, w: Weights): number {
  const s =
    w.alpha * (r.price / NORM.price) +
    w.beta * (r.pue / NORM.pue) +
    w.gamma * (r.carbon / NORM.carbon) +
    w.delta * ((r.latency ?? 0) / NORM.latency)
  return Math.round(s * 100 * 100) / 100
}

/** Score + sort ascending (best first). Input regions may already carry latency. */
export function rankRegions(
  regions: (RegionData & { latency?: number })[],
  w: Weights
): ScoredRegion[] {
  return regions
    .map((r) => ({ ...r, latency: r.latency ?? 0, composite_score: scoreRegion(r, w) }))
    .sort((a, b) => a.composite_score - b.composite_score)
}

export const allRegionNames = () => REGIONS.map((r) => r.name)
