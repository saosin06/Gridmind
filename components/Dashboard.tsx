'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { loadScorer } from '../lib/loadScorer'
import AgentPanel from './AgentPanel'

type CloudRegion = {
  name: string
  price: number
  pue: number
  carbon: number
  latency: number
  composite_score: number
}

type RouteResponse = {
  recommendation: string
  top3: CloudRegion[]
  scores: { region: string; score: number }[]
}

type WeatherRow = { region: string; temp_f: number }
type ForecastPoint = { datetime: string; carbon: number }
type RegionForecast = { region: string; zone: string; forecast: ForecastPoint[] }
type Telemetry = { js: number; wasm: number | null; iterations: number }
type EngineStatus = 'loading' | 'wasm' | 'fallback'
type Weights = { alpha: number; beta: number; gamma: number; delta: number }

const WEIGHTS = [
  { key: 'alpha' as const, label: 'Cost',       sym: 'α', hint: 'electricity price' },
  { key: 'beta'  as const, label: 'Efficiency', sym: 'β', hint: 'facility PUE' },
  { key: 'gamma' as const, label: 'Carbon',     sym: 'γ', hint: 'grid intensity' },
  { key: 'delta' as const, label: 'Latency',    sym: 'δ', hint: 'user proximity' },
]

const PRESETS = [
  { key: 'training',  label: 'Training',  w: { alpha: 0.25, beta: 0.10, gamma: 0.60, delta: 0.05 }, hint: 'carbon-first' },
  { key: 'inference', label: 'Inference', w: { alpha: 0.15, beta: 0.20, gamma: 0.15, delta: 0.50 }, hint: 'latency-first' },
  { key: 'batch',     label: 'Batch',     w: { alpha: 0.60, beta: 0.15, gamma: 0.20, delta: 0.05 }, hint: 'cost-first' },
  { key: 'balanced',  label: 'Balanced',  w: { alpha: 0.30, beta: 0.20, gamma: 0.25, delta: 0.25 }, hint: 'even' },
]
const DEFAULT_W: Weights = PRESETS[3].w

// data-center coordinates
const REGION_COORDS: Record<string, { lat: number; lon: number }> = {
  'San Jose': { lat: 37.3382, lon: -121.8863 },
  'Ashburn':  { lat: 38.9940, lon: -77.4897 },
  'Austin':   { lat: 30.2672, lon: -97.7431 },
}
// where the workload's users are (for latency estimate)
const USER_LOCS = [
  { key: 'us-east',    label: 'US East (Virginia)', lat: 38.95, lon: -77.45 },
  { key: 'us-west',    label: 'US West (Bay Area)', lat: 37.77, lon: -122.42 },
  { key: 'us-central', label: 'US Central (Chicago)', lat: 41.88, lon: -87.63 },
  { key: 'eu',         label: 'Europe (London)', lat: 51.51, lon: -0.13 },
  { key: 'apac',       label: 'APAC (Singapore)', lat: 1.35, lon: 103.82 },
]

const BENCH_N = 3_000_000

// ── helpers ───────────────────────────────────────────────────────────
const fmtPrice = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const fmtMoney = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`
const carbonTone = (c: number) =>
  c < 150 ? { dot: 'bg-emerald-400', text: 'text-emerald-300' }
  : c < 350 ? { dot: 'bg-amber-400', text: 'text-amber-300' }
  : { dot: 'bg-rose-400', text: 'text-rose-300' }

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const la1 = a.lat * rad, la2 = b.lat * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
// RTT estimate: ~200 km/ms in fiber, ×2 round-trip, ×1.4 path inflation, +5ms base
const estLatency = (distKm: number) => Math.round((distKm / 200) * 2 * 1.4 + 5)
function latencyFor(region: string, locKey: string): number {
  const dc = REGION_COORDS[region]
  const u = USER_LOCS.find((l) => l.key === locKey)
  return dc && u ? estLatency(haversineKm(u, dc)) : 0
}

function jsBenchmark(n: number, a: number, b: number, g: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) {
    const price = (i % 200) - 50
    const pue = 1.4 + (i % 30) * 0.01
    const carbon = i % 500
    acc += a * price + b * pue + g * carbon
  }
  return acc
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function bestOf(fn: () => void, warmup: number, runs: number): number {
  for (let i = 0; i < warmup; i++) fn()
  let best = Infinity
  for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t) }
  return best
}

export default function Dashboard() {
  const [weights, setWeights] = useState<Weights>(DEFAULT_W)
  const [userLoc, setUserLoc] = useState('us-east')
  const [mw, setMw] = useState(5)
  const [hours, setHours] = useState(24)

  const [regions, setRegions]         = useState<CloudRegion[]>([])
  const [weather, setWeather]         = useState<WeatherRow[]>([])
  const [forecasts, setForecasts]     = useState<RegionForecast[]>([])
  const [routeResult, setRouteResult] = useState<RouteResponse | null>(null)
  const [report, setReport]           = useState('')
  const [reportLoading, setReportLoading] = useState(true)
  const [telemetry, setTelemetry]     = useState<Telemetry | null>(null)
  const [engine, setEngine]           = useState<EngineStatus>('loading')
  const [engineError, setEngineError] = useState('')
  const [loading, setLoading]         = useState(true)
  const [updatedAt, setUpdatedAt]     = useState('')

  // refs to avoid stale reads inside debounced/async callbacks
  const wRef = useRef(weights); useEffect(() => { wRef.current = weights }, [weights])
  const locRef = useRef(userLoc); useEffect(() => { locRef.current = userLoc }, [userLoc])
  const regionsRef = useRef(regions); useEffect(() => { regionsRef.current = regions }, [regions])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── scoring round-trip ──────────────────────────────────────────────
  const callRoute = useCallback(async (r: CloudRegion[], w: Weights): Promise<RouteResponse> => {
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ regions: r, alpha: w.alpha, beta: w.beta, gamma: w.gamma, delta: w.delta }),
    })
    return res.json()
  }, [])

  // recompute latency for the current user location, re-rank, update scores
  const rerank = useCallback(async (base: CloudRegion[]): Promise<RouteResponse | null> => {
    if (!base.length) return null
    const withLat = base.map((r) => ({ ...r, latency: latencyFor(r.name, locRef.current) }))
    try {
      const route = await callRoute(withLat, wRef.current)
      const scoreMap = new Map(route.scores.map((s) => [s.region, s.score]))
      setRegions(withLat.map((r) => ({ ...r, composite_score: scoreMap.get(r.name) ?? 0 })))
      setRouteResult(route)
      return route
    } catch (err) {
      console.error('[Dashboard] rerank', err)
      return null
    }
  }, [callRoute])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setReportLoading(true)
    try {
      const [aggRes, wthRes, fcRes] = await Promise.all([
        fetch('/api/aggregate'), fetch('/api/weather'), fetch('/api/forecast'),
      ])
      const agg: CloudRegion[] = await aggRes.json()
      const wth: WeatherRow[]  = await wthRes.json().catch(() => [])
      const fc: RegionForecast[] = await fcRes.json().catch(() => [])

      setWeather(wth)
      setForecasts(fc)
      const route = await rerank(agg)
      setUpdatedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      setLoading(false)

      if (route) {
        try {
          const aRes = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ recommendation: route.recommendation, top3: route.top3, scores: route.scores }),
          })
          const { report: rep = '' } = await aRes.json()
          setReport(rep || '_No analysis returned._')
        } catch { setReport('_Analysis unavailable right now._') }
      }
      setReportLoading(false)
    } catch (err) {
      console.error('[Dashboard] loadAll', err)
      setLoading(false); setReportLoading(false)
    }
  }, [rerank])

  // ── WASM engine: load, smoke-test, benchmark (speed demo only) ──────
  const runBenchmark = useCallback(async () => {
    const { alpha, beta, gamma } = wRef.current
    setTelemetry(null)
    const jsMs = bestOf(() => { jsBenchmark(BENCH_N, alpha, beta, gamma) }, 2, 3)
    try {
      const m = await loadScorer()
      const gm = new m.GridMatcher()
      gm.calculate_score(45.5, 1.55, 234, alpha, beta, gamma)
      gm.benchmark_score(BENCH_N, alpha, beta, gamma)
      gm.benchmark_score(BENCH_N, alpha, beta, gamma)
      await sleep(60)
      const wasmMs = bestOf(() => { gm.benchmark_score(BENCH_N, alpha, beta, gamma) }, 1, 3)
      gm.delete()
      setEngine('wasm'); setEngineError(''); setTelemetry({ js: jsMs, wasm: wasmMs, iterations: BENCH_N })
    } catch (err) {
      console.warn('[WASM] init failed — JS fallback', err)
      setEngine('fallback')
      setEngineError(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
      setTelemetry({ js: jsMs, wasm: null, iterations: BENCH_N })
    }
  }, [])

  useEffect(() => {
    loadAll(); runBenchmark()
    const id = setInterval(loadAll, 10 * 60 * 1000)
    return () => clearInterval(id)
  }, [loadAll, runBenchmark])

  // weight slider -> debounced re-rank
  function handleWeight(key: keyof Weights, v: number) {
    setWeights((prev) => { const next = { ...prev, [key]: v }; wRef.current = next; return next })
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { rerank(regionsRef.current) }, 200)
  }
  function applyPreset(w: Weights) { setWeights(w); wRef.current = w; rerank(regionsRef.current) }
  function changeLocation(key: string) { setUserLoc(key); locRef.current = key; rerank(regionsRef.current) }

  // ── derived ─────────────────────────────────────────────────────────
  const ranked = [...regions].sort((a, b) => a.composite_score - b.composite_score)
  const best = routeResult?.recommendation ? regions.find((r) => r.name === routeResult.recommendation) : ranked[0]
  const worst = ranked.length ? ranked[ranked.length - 1] : undefined
  const bestWeather = weather.find((w) => w.region === best?.name)
  const maxScore = Math.max(1, ...ranked.map((r) => Math.abs(r.composite_score)))
  const tempFor = (name: string) => { const w = weather.find((x) => x.region === name); return w ? `${w.temp_f}°F` : '—' }
  const speedup = telemetry?.wasm ? telemetry.js / telemetry.wasm : null
  const maxBench = telemetry ? Math.max(telemetry.js, telemetry.wasm ?? 0) : 1

  // workload economics (facility MWh = MW × hours × PUE)
  const econ = (r: CloudRegion) => {
    const facMwh = mw * hours * r.pue
    return { cost: facMwh * r.price, co2t: (facMwh * r.carbon) / 1000 }
  }
  const bestEcon = best ? econ(best) : null
  const worstEcon = worst ? econ(worst) : null
  const costSaved = bestEcon && worstEcon ? worstEcon.cost - bestEcon.cost : 0
  const co2Saved = bestEcon && worstEcon ? worstEcon.co2t - bestEcon.co2t : 0

  // time-shift: lowest-carbon hour ahead for the recommended region
  const recFc = forecasts.find((f) => f.region === best?.name)?.forecast ?? []
  const nowCarbon = best?.carbon ?? 0
  let timeShift: { hoursAway: number; carbon: number; pct: number } | null = null
  if (recFc.length && nowCarbon > 0) {
    const min = recFc.reduce((a, b) => (b.carbon < a.carbon ? b : a))
    const pct = Math.round(((nowCarbon - min.carbon) / nowCarbon) * 100)
    const hoursAway = Math.max(1, Math.round((new Date(min.datetime).getTime() - Date.now()) / 3_600_000))
    if (pct >= 15) timeShift = { hoursAway, carbon: min.carbon, pct }
  }

  const card = 'rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg shadow-black/30'

  return (
    <div className="min-h-screen w-full bg-[#070b12] text-slate-100">
      <div className="mx-auto w-full max-w-[1900px] px-5 py-6 sm:px-8">

        {/* ── Header ─────────────────────────────────────────────── */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-teal-600 shadow-lg shadow-emerald-500/20">
              <span className="text-lg font-bold text-slate-950">G</span>
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">GridMind</h1>
              <p className="text-xs text-slate-400">Compute workload router</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              Live{updatedAt && <span className="text-slate-500">· {updatedAt}</span>}
            </span>
            <EnginePill engine={engine} />
          </div>
        </header>

        {engineError && (
          <div className="mb-5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">
            WASM engine error → {engineError} <span className="text-rose-400/70">(using JS fallback — results identical)</span>
          </div>
        )}

        {/* ── Main frame: left content + right report ─────────────── */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          {/* LEFT column */}
          <div className="space-y-5 xl:col-span-8">

            {/* routing agent — the deploy action */}
            <AgentPanel />

            {/* hero + controls */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              <section className={`relative overflow-hidden lg:col-span-2 ${card} flex flex-col p-6`}>
                <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-emerald-500/10 blur-3xl" />
                <p className="text-xs font-medium uppercase tracking-widest text-emerald-400">Recommended region</p>
                {loading || !best ? (
                  <div className="mt-3 space-y-3">
                    <div className="h-9 w-48 animate-pulse rounded bg-slate-800" />
                    <div className="h-16 w-full animate-pulse rounded bg-slate-800/60" />
                  </div>
                ) : (
                  <div className="gm-fade-up flex flex-1 flex-col">
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <h2 className="text-4xl font-semibold tracking-tight">{best.name}</h2>
                      <span className="mb-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-sm font-medium text-emerald-300">
                        score {best.composite_score.toFixed(2)}
                      </span>
                    </div>
                    <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800 sm:grid-cols-4">
                      <HeroStat label="Price" value={fmtPrice(best.price)} unit="/MWh" tone={best.price < 0 ? 'text-emerald-300' : 'text-slate-100'} />
                      <HeroStat label="Carbon" value={`${best.carbon}`} unit="gCO₂/kWh" tone={carbonTone(best.carbon).text} />
                      <HeroStat label="PUE" value={best.pue.toFixed(2)} unit="ratio" tone="text-slate-100" />
                      <HeroStat label="Latency" value={`${best.latency}`} unit="ms est" tone="text-slate-100" />
                    </div>
                    {worst && costSaved > 0 && (
                      <p className="mt-4 text-sm text-slate-400">
                        Over {hours}h at {mw} MW, routing here saves{' '}
                        <span className="font-semibold text-emerald-300">{fmtMoney(costSaved)}</span> and{' '}
                        <span className="font-semibold text-emerald-300">{co2Saved.toFixed(1)} t CO₂</span>{' '}
                        vs {worst.name}.
                      </p>
                    )}
                  </div>
                )}
              </section>

              {/* Controls */}
              <section className={`${card} p-6`}>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-200">Weighting</h3>
                  <button onClick={() => applyPreset(DEFAULT_W)} className="rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-200">Reset</button>
                </div>
                <div className="mb-4 grid grid-cols-2 gap-2">
                  {PRESETS.map((p) => (
                    <button key={p.key} onClick={() => applyPreset(p.w)}
                      className="rounded-lg border border-slate-700 bg-slate-800/50 px-2.5 py-2 text-left transition hover:border-emerald-500/40 hover:bg-slate-800">
                      <span className="block text-xs font-medium text-slate-200">{p.label}</span>
                      <span className="block text-[10px] text-slate-500">{p.hint}</span>
                    </button>
                  ))}
                </div>
                <label className="mb-1 block text-xs text-slate-400">Users located in</label>
                <select value={userLoc} onChange={(e) => changeLocation(e.target.value)}
                  className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500/50">
                  {USER_LOCS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                </select>
                <div className="space-y-4">
                  {WEIGHTS.map(({ key, label, sym, hint }) => {
                    const v = weights[key]
                    return (
                      <div key={key}>
                        <div className="mb-1 flex items-baseline justify-between">
                          <label htmlFor={`w-${key}`} className="text-sm text-slate-300">
                            {label} <span className="text-slate-500">{sym}</span>
                            <span className="ml-1.5 text-xs text-slate-600">{hint}</span>
                          </label>
                          <span className="font-mono text-sm tabular-nums text-emerald-300">{v.toFixed(2)}</span>
                        </div>
                        <input id={`w-${key}`} type="range" min={0} max={1} step={0.01} value={v}
                          onChange={(e) => handleWeight(key, parseFloat(e.target.value))}
                          className="gm-slider w-full"
                          style={{ background: `linear-gradient(to right, #10b981 ${v * 100}%, #1e2a3a ${v * 100}%)` }} />
                      </div>
                    )
                  })}
                </div>
              </section>
            </div>

            {/* calculator + time-shift */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {/* Cost calculator */}
              <section className={`${card} p-6`}>
                <h3 className="text-sm font-semibold text-slate-200">Workload cost</h3>
                <p className="mt-0.5 text-xs text-slate-500">estimated for the recommended region</p>
                <div className="mt-4 flex gap-3">
                  <NumField label="Load (MW)" value={mw} min={1} max={500} onChange={setMw} />
                  <NumField label="Duration (h)" value={hours} min={1} max={720} onChange={setHours} />
                </div>
                {best && bestEcon ? (
                  <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800">
                    <div className="bg-slate-900 px-4 py-3">
                      <p className="text-xs text-slate-500">Energy cost</p>
                      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${bestEcon.cost < 0 ? 'text-emerald-300' : 'text-slate-100'}`}>{fmtMoney(bestEcon.cost)}</p>
                      <p className="text-[10px] text-slate-600">{bestEcon.cost < 0 ? 'net grid revenue' : `at ${best.name}`}</p>
                    </div>
                    <div className="bg-slate-900 px-4 py-3">
                      <p className="text-xs text-slate-500">Carbon</p>
                      <p className="mt-0.5 text-xl font-semibold tabular-nums text-slate-100">{bestEcon.co2t.toFixed(1)} t</p>
                      <p className="text-[10px] text-slate-600">CO₂ over {hours}h</p>
                    </div>
                  </div>
                ) : <div className="mt-4 h-20 animate-pulse rounded bg-slate-800/60" />}
              </section>

              {/* Carbon outlook / time-shift */}
              <section className={`${card} p-6`}>
                <h3 className="text-sm font-semibold text-slate-200">Carbon outlook</h3>
                <p className="mt-0.5 text-xs text-slate-500">{best ? `${best.name} · next 24h forecast` : 'forecast'}</p>
                {recFc.length ? (
                  <>
                    <div className="mt-4"><Sparkline points={recFc.map((p) => p.carbon)} /></div>
                    <div className="mt-3 flex items-center justify-between text-xs">
                      <span className="text-slate-500">now <span className="tabular-nums text-slate-300">{nowCarbon} g</span></span>
                      <span className="text-slate-500">24h range <span className="tabular-nums text-slate-300">{Math.min(...recFc.map((p) => p.carbon))}–{Math.max(...recFc.map((p) => p.carbon))} g</span></span>
                    </div>
                    {timeShift ? (
                      <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                        Shift ~{timeShift.hoursAway}h → carbon drops {timeShift.pct}% to {timeShift.carbon} gCO₂/kWh.
                      </p>
                    ) : (
                      <p className="mt-3 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2 text-xs text-slate-400">
                        Running now is near-optimal — no material carbon gain from waiting.
                      </p>
                    )}
                  </>
                ) : <div className="mt-4 h-24 animate-pulse rounded bg-slate-800/60" />}
              </section>
            </div>

            {/* Region matrix */}
            <section className={`${card} overflow-hidden`}>
              <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
                <h3 className="text-sm font-semibold text-slate-200">Region matrix</h3>
                <span className="text-xs text-slate-500">ranked by composite score · lower is better</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-6 py-3 font-medium">Region</th>
                      <th className="px-6 py-3 font-medium">Temp</th>
                      <th className="px-6 py-3 text-right font-medium">Price $/MWh</th>
                      <th className="px-6 py-3 font-medium">Carbon gCO₂/kWh</th>
                      <th className="px-6 py-3 text-right font-medium">PUE</th>
                      <th className="px-6 py-3 text-right font-medium">Latency</th>
                      <th className="px-6 py-3 font-medium">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading
                      ? Array.from({ length: 3 }).map((_, i) => (
                          <tr key={i} className="border-t border-slate-800/70">
                            {Array.from({ length: 7 }).map((__, j) => (
                              <td key={j} className="px-6 py-4"><div className="h-4 w-16 animate-pulse rounded bg-slate-800" /></td>
                            ))}
                          </tr>
                        ))
                      : ranked.map((r) => {
                          const isBest = r.name === best?.name
                          const tone = carbonTone(r.carbon)
                          return (
                            <tr key={r.name} className={`border-t border-slate-800/70 transition-colors ${isBest ? 'bg-emerald-500/[0.06]' : 'hover:bg-slate-800/40'}`}>
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-2">
                                  <span className={`h-5 w-1 rounded-full ${isBest ? 'bg-emerald-400' : 'bg-transparent'}`} />
                                  <span className="font-medium text-slate-100">{r.name}</span>
                                  {isBest && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">Best</span>}
                                </div>
                              </td>
                              <td className="px-6 py-4 tabular-nums text-slate-400">{tempFor(r.name)}</td>
                              <td className={`px-6 py-4 text-right tabular-nums ${r.price < 0 ? 'text-emerald-300' : 'text-slate-200'}`}>{fmtPrice(r.price)}</td>
                              <td className="px-6 py-4">
                                <span className={`inline-flex items-center gap-2 tabular-nums ${tone.text}`}>
                                  <span className={`h-2 w-2 rounded-full ${tone.dot}`} />{r.carbon}
                                </span>
                              </td>
                              <td className="px-6 py-4 text-right tabular-nums text-slate-200">{r.pue.toFixed(2)}</td>
                              <td className="px-6 py-4 text-right tabular-nums text-slate-300">{r.latency} ms</td>
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-2">
                                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-800">
                                    <div className={`h-full rounded-full ${isBest ? 'bg-emerald-400' : 'bg-slate-500'}`} style={{ width: `${Math.min(100, (Math.abs(r.composite_score) / maxScore) * 100)}%` }} />
                                  </div>
                                  <span className="tabular-nums text-slate-300">{r.composite_score.toFixed(2)}</span>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Engine performance */}
            <section className={`${card} p-6`}>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200">Engine performance</h3>
                <button onClick={runBenchmark} className="rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-200">Re-run</button>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">calculate_score × {BENCH_N.toLocaleString()} · warm, best of 3</p>
              {!telemetry ? (
                <div className="mt-5 h-24 animate-pulse rounded bg-slate-800/60" />
              ) : (
                <div className="mt-5 space-y-4">
                  {speedup && (
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
                      WASM {speedup >= 1 ? `${speedup.toFixed(1)}× faster` : `${(1 / speedup).toFixed(1)}× slower`}
                    </div>
                  )}
                  <BenchBar label="JavaScript" ms={telemetry.js} max={maxBench} color="bg-amber-400" textColor="text-amber-300" />
                  {telemetry.wasm !== null
                    ? <BenchBar label="WebAssembly" ms={telemetry.wasm} max={maxBench} color="bg-emerald-400" textColor="text-emerald-300" />
                    : <div className="text-xs text-slate-500">WASM unavailable — fell back to JS.</div>}
                </div>
              )}
            </section>
          </div>{/* end LEFT column */}

          {/* RIGHT column: AI report — sticky, fills the frame */}
          <aside className="xl:col-span-4 xl:sticky xl:top-6 xl:self-start">
          <section className={`${card} flex flex-col p-6 xl:h-[calc(100vh-7rem)]`}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">AI arbitrage analysis</h3>
              {routeResult?.recommendation && (
                <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-emerald-300">→ {routeResult.recommendation}</span>
              )}
            </div>
            <div className="min-h-[220px] flex-1 overflow-y-auto rounded-lg border border-slate-800 bg-[#0a111c] p-5">
              {reportLoading ? (
                <div className="space-y-2.5">
                  {[90, 75, 82, 60, 70, 50].map((w, i) => (
                    <div key={i} className="h-3 animate-pulse rounded bg-slate-800" style={{ width: `${w}%` }} />
                  ))}
                  <p className="pt-2 text-xs text-slate-500">Claude is analyzing the arbitrage…</p>
                </div>
              ) : (
                <div className="report-md gm-fade-up">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
                </div>
              )}
            </div>
          </section>
          </aside>
        </div>{/* end main frame */}

        {/* ── Footer ─────────────────────────────────────────────── */}
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 pt-5 text-xs text-slate-600">
          <span>Live data · OpenWeatherMap · Electricity Maps · GridStatus.io · Anthropic</span>
          <span>Scoring in {engine === 'wasm' ? 'WebAssembly (C++)' : 'JavaScript'}</span>
        </footer>
      </div>
    </div>
  )
}

// ── small presentational components ───────────────────────────────────
function EnginePill({ engine }: { engine: EngineStatus }) {
  if (engine === 'loading')
    return <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-400">engine: initializing…</span>
  if (engine === 'wasm')
    return <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />WASM engine</span>
  return <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-amber-300"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />JS fallback</span>
}

function HeroStat({ label, value, unit, tone }: { label: string; value: string; unit: string; tone: string }) {
  return (
    <div className="bg-slate-900 px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="text-[10px] text-slate-600">{unit}</p>
    </div>
  )
}

function NumField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <label className="flex-1">
      <span className="mb-1 block text-xs text-slate-400">{label}</span>
      <input type="number" value={value} min={min} max={max}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm tabular-nums text-slate-100 outline-none focus:border-emerald-500/50" />
    </label>
  )
}

function BenchBar({ label, ms, max, color, textColor }: { label: string; ms: number; max: number; color: string; textColor: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className={`font-mono tabular-nums ${textColor}`}>{ms.toFixed(2)} ms</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${Math.max(4, (ms / max) * 100)}%` }} />
      </div>
    </div>
  )
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null
  const max = Math.max(...points), min = Math.min(...points)
  const range = max - min || 1
  const h = 40, w = 100, step = w / (points.length - 1)
  const path = points.map((p, i) => `${(i * step).toFixed(1)},${(h - ((p - min) / range) * h).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-12 w-full">
      <polyline points={path} fill="none" stroke="#34d399" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
