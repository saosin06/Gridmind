'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { loadScorer } from '../lib/loadScorer'

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

type WeatherRow = { region: string; temp_f: number }
type Telemetry = { js: number; wasm: number | null; iterations: number }
type EngineStatus = 'loading' | 'wasm' | 'fallback'

const WEIGHTS = [
  { key: 'alpha' as const, label: 'Cost',       sym: 'α', hint: 'electricity price' },
  { key: 'beta'  as const, label: 'Efficiency', sym: 'β', hint: 'facility PUE' },
  { key: 'gamma' as const, label: 'Carbon',     sym: 'γ', hint: 'grid intensity' },
]

const BENCH_N = 3_000_000

// ── formatting / helpers ──────────────────────────────────────────────
const fmtPrice = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const carbonTone = (c: number) =>
  c < 150 ? { dot: 'bg-emerald-400', text: 'text-emerald-300' }
  : c < 350 ? { dot: 'bg-amber-400', text: 'text-amber-300' }
  : { dot: 'bg-rose-400', text: 'text-rose-300' }

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

// Warm the engine (so V8 tiers WASM up from Liftoff to TurboFan and JITs the JS
// loop), then take the best of several timed runs to measure steady-state.
function bestOf(fn: () => void, warmup: number, runs: number): number {
  for (let i = 0; i < warmup; i++) fn()
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    fn()
    best = Math.min(best, performance.now() - t)
  }
  return best
}

export default function Dashboard() {
  const [alpha, setAlpha] = useState(0.4)
  const [beta,  setBeta]  = useState(0.3)
  const [gamma, setGamma] = useState(0.3)

  const [regions, setRegions]         = useState<CloudRegion[]>([])
  const [weather, setWeather]         = useState<WeatherRow[]>([])
  const [routeResult, setRouteResult] = useState<RouteResponse | null>(null)
  const [report, setReport]           = useState('')
  const [reportLoading, setReportLoading] = useState(true)
  const [telemetry, setTelemetry]     = useState<Telemetry | null>(null)
  const [engine, setEngine]           = useState<EngineStatus>('loading')
  const [engineError, setEngineError] = useState('')
  const [loading, setLoading]         = useState(true)
  const [updatedAt, setUpdatedAt]     = useState('')

  // refs mirror weights so the debounced callback never reads stale values
  const aRef = useRef(alpha); const bRef = useRef(beta); const gRef = useRef(gamma)
  useEffect(() => { aRef.current = alpha }, [alpha])
  useEffect(() => { bRef.current = beta  }, [beta])
  useEffect(() => { gRef.current = gamma }, [gamma])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const weightVals = { alpha, beta, gamma }
  const setWeight = (k: 'alpha' | 'beta' | 'gamma', v: number) =>
    k === 'alpha' ? setAlpha(v) : k === 'beta' ? setBeta(v) : setGamma(v)

  // ── API calls ───────────────────────────────────────────────────────
  const callRoute = useCallback(async (r: CloudRegion[], a: number, b: number, g: number): Promise<RouteResponse> => {
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ regions: r, alpha: a, beta: b, gamma: g }),
    })
    return res.json()
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setReportLoading(true)
    try {
      const [aggRes, wthRes] = await Promise.all([fetch('/api/aggregate'), fetch('/api/weather')])
      const agg: CloudRegion[] = await aggRes.json()
      const wth: WeatherRow[]  = await wthRes.json().catch(() => [])

      const route = await callRoute(agg, aRef.current, bRef.current, gRef.current)
      const scoreMap = new Map(route.scores.map((s) => [s.region, s.score]))
      const scored = agg.map((r) => ({ ...r, composite_score: scoreMap.get(r.name) ?? 0 }))

      setRegions(scored)
      setWeather(wth)
      setRouteResult(route)
      setUpdatedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      setLoading(false)

      // analyze is slowest — let the rest render first
      try {
        const aRes = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ recommendation: route.recommendation, top3: route.top3, scores: route.scores }),
        })
        const { report: rep = '' } = await aRes.json()
        setReport(rep || '_No analysis returned._')
      } catch {
        setReport('_Analysis unavailable right now._')
      } finally {
        setReportLoading(false)
      }
    } catch (err) {
      console.error('[Dashboard] loadAll', err)
      setLoading(false)
      setReportLoading(false)
    }
  }, [callRoute])

  // ── WASM engine: load, smoke-test, benchmark ────────────────────────
  const runBenchmark = useCallback(async () => {
    const a = aRef.current, b = bRef.current, g = gRef.current
    setTelemetry(null)
    // JS: warm the JIT, then best-of-3 steady-state
    const jsMs = bestOf(() => { jsBenchmark(BENCH_N, a, b, g) }, 2, 3)
    try {
      const m = await loadScorer()
      const gm = new m.GridMatcher()
      gm.calculate_score(45.5, 1.55, 234, a, b, g) // smoke test
      // Warm WASM so V8 tiers it up to TurboFan; yield so the background
      // optimizing compile finishes before the timed runs (else it's Liftoff).
      gm.benchmark_score(BENCH_N, a, b, g)
      gm.benchmark_score(BENCH_N, a, b, g)
      await sleep(60)
      const wasmMs = bestOf(() => { gm.benchmark_score(BENCH_N, a, b, g) }, 1, 3)
      gm.delete()
      setEngine('wasm')
      setEngineError('')
      setTelemetry({ js: jsMs, wasm: wasmMs, iterations: BENCH_N })
    } catch (err) {
      console.warn('[WASM] init failed — JS fallback', err)
      setEngine('fallback')
      setEngineError(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
      setTelemetry({ js: jsMs, wasm: null, iterations: BENCH_N })
    }
  }, [])

  // mount: load data + run benchmark + 10-min refresh
  useEffect(() => {
    loadAll()
    runBenchmark()
    const id = setInterval(loadAll, 10 * 60 * 1000)
    return () => clearInterval(id)
  }, [loadAll, runBenchmark])

  // slider change -> debounced re-rank
  function handleWeight(k: 'alpha' | 'beta' | 'gamma', v: number) {
    setWeight(k, v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      if (!regions.length) return
      try {
        const route = await callRoute(regions, aRef.current, bRef.current, gRef.current)
        const scoreMap = new Map(route.scores.map((s) => [s.region, s.score]))
        setRegions((prev) => prev.map((r) => ({ ...r, composite_score: scoreMap.get(r.name) ?? r.composite_score })))
        setRouteResult(route)
      } catch (err) {
        console.error('[Dashboard] route', err)
      }
    }, 250)
  }

  // ── derived ─────────────────────────────────────────────────────────
  const ranked = [...regions].sort((a, b) => a.composite_score - b.composite_score)
  const best = routeResult?.recommendation
    ? regions.find((r) => r.name === routeResult.recommendation)
    : ranked[0]
  const bestWeather = weather.find((w) => w.region === best?.name)
  const maxScore = Math.max(1, ...ranked.map((r) => Math.abs(r.composite_score)))
  const tempFor = (name: string) => {
    const w = weather.find((x) => x.region === name)
    return w ? `${w.temp_f}°F` : '—'
  }
  const speedup = telemetry?.wasm ? telemetry.js / telemetry.wasm : null
  const maxBench = telemetry ? Math.max(telemetry.js, telemetry.wasm ?? 0) : 1

  const card = 'rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg shadow-black/30'

  return (
    <div className="min-h-screen w-full bg-[#070b12] text-slate-100">
      <div className="mx-auto w-full max-w-[1900px] px-5 py-6 sm:px-8">

        {/* ── Header ─────────────────────────────────────────────── */}
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
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

            {/* hero + controls */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Hero */}
          <section className={`relative overflow-hidden lg:col-span-2 ${card} p-6`}>
            <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-emerald-500/10 blur-3xl" />
            <p className="text-xs font-medium uppercase tracking-widest text-emerald-400">Recommended region</p>
            {loading || !best ? (
              <div className="mt-3 space-y-3">
                <div className="h-9 w-48 animate-pulse rounded bg-slate-800" />
                <div className="h-16 w-full animate-pulse rounded bg-slate-800/60" />
              </div>
            ) : (
              <div className="gm-fade-up">
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
                  <HeroStat label="Temp" value={bestWeather ? `${bestWeather.temp_f}` : '—'} unit="°F" tone="text-slate-100" />
                </div>
              </div>
            )}
          </section>

          {/* Controls */}
          <section className={`${card} p-6`}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">Weighting</h3>
              <button
                onClick={() => { setAlpha(0.4); setBeta(0.3); setGamma(0.3); handleWeight('alpha', 0.4) }}
                className="rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
              >
                Reset
              </button>
            </div>
            <div className="space-y-5">
              {WEIGHTS.map(({ key, label, sym, hint }) => {
                const v = weightVals[key]
                return (
                  <div key={key}>
                    <div className="mb-1.5 flex items-baseline justify-between">
                      <label htmlFor={`w-${key}`} className="text-sm text-slate-300">
                        {label} <span className="text-slate-500">{sym}</span>
                        <span className="ml-1.5 text-xs text-slate-600">{hint}</span>
                      </label>
                      <span className="font-mono text-sm tabular-nums text-emerald-300">{v.toFixed(2)}</span>
                    </div>
                    <input
                      id={`w-${key}`}
                      type="range" min={0} max={1} step={0.01} value={v}
                      onChange={(e) => handleWeight(key, parseFloat(e.target.value))}
                      className="gm-slider w-full"
                      style={{ background: `linear-gradient(to right, #10b981 ${v * 100}%, #1e2a3a ${v * 100}%)` }}
                    />
                  </div>
                )
              })}
            </div>
          </section>
        </div>

        {/* ── Region matrix ──────────────────────────────────────── */}
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
                  <th className="px-6 py-3 font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 3 }).map((_, i) => (
                      <tr key={i} className="border-t border-slate-800/70">
                        {Array.from({ length: 6 }).map((__, j) => (
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

          {/* ── Engine performance (left column) ──────────────────── */}
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
                    ⚡ WASM {speedup >= 1 ? `${speedup.toFixed(1)}× faster` : `${(1 / speedup).toFixed(1)}× slower`}
                  </div>
                )}
                <BenchBar label="JavaScript" ms={telemetry.js} max={maxBench} color="bg-amber-400" textColor="text-amber-300" />
                {telemetry.wasm !== null ? (
                  <BenchBar label="WebAssembly" ms={telemetry.wasm} max={maxBench} color="bg-emerald-400" textColor="text-emerald-300" />
                ) : (
                  <div className="text-xs text-slate-500">WASM unavailable — fell back to JS.</div>
                )}
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
