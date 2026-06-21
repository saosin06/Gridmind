'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import AgentPanel from './AgentPanel'
import FleetScheduler from './FleetScheduler'
import DevPanel from './DevPanel'

type CloudRegion = {
  name: string
  price: number
  pue: number
  carbon: number
  latency: number
  composite_score: number
  renewable_pct?: number
  fossil_free_pct?: number
  top_source?: string
}
type RouteResponse = {
  recommendation: string
  top3: CloudRegion[]
  scores: { region: string; score: number }[]
}
type WeatherRow = { region: string; temp_f: number }
type ForecastPoint = { datetime: string; carbon: number }
type RegionForecast = { region: string; zone: string; forecast: ForecastPoint[] }
type Weights = { alpha: number; beta: number; gamma: number; delta: number }
type Tab = 'overview' | 'router' | 'fleet'

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

const REGION_COORDS: Record<string, { lat: number; lon: number }> = {
  'San Jose': { lat: 37.3382, lon: -121.8863 },
  'Ashburn':  { lat: 38.9940, lon: -77.4897 },
  'Austin':   { lat: 30.2672, lon: -97.7431 },
}
const USER_LOCS = [
  { key: 'us-east',    label: 'US East (Virginia)', lat: 38.95, lon: -77.45 },
  { key: 'us-west',    label: 'US West (Bay Area)', lat: 37.77, lon: -122.42 },
  { key: 'us-central', label: 'US Central (Chicago)', lat: 41.88, lon: -87.63 },
  { key: 'eu',         label: 'Europe (London)', lat: 51.51, lon: -0.13 },
  { key: 'apac',       label: 'APAC (Singapore)', lat: 1.35, lon: 103.82 },
]

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
const estLatency = (distKm: number) => Math.round((distKm / 200) * 2 * 1.4 + 5)
function latencyFor(region: string, locKey: string): number {
  const dc = REGION_COORDS[region]
  const u = USER_LOCS.find((l) => l.key === locKey)
  return dc && u ? estLatency(haversineKm(u, dc)) : 0
}

const card = 'gm-card'

export default function Dashboard() {
  const [weights, setWeights] = useState<Weights>(DEFAULT_W)
  const [userLoc, setUserLoc] = useState('us-east')
  const [regions, setRegions]         = useState<CloudRegion[]>([])
  const [weather, setWeather]         = useState<WeatherRow[]>([])
  const [forecasts, setForecasts]     = useState<RegionForecast[]>([])
  const [routeResult, setRouteResult] = useState<RouteResponse | null>(null)
  const [report, setReport]           = useState('')
  const [reportLoading, setReportLoading] = useState(true)
  const [loading, setLoading]         = useState(true)
  const [updatedAt, setUpdatedAt]     = useState('')
  const [tab, setTab]                 = useState<Tab>('overview')
  const [showDev, setShowDev]         = useState(false)

  const wRef = useRef(weights); useEffect(() => { wRef.current = weights }, [weights])
  const locRef = useRef(userLoc); useEffect(() => { locRef.current = userLoc }, [userLoc])
  const regionsRef = useRef(regions); useEffect(() => { regionsRef.current = regions }, [regions])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const callRoute = useCallback(async (r: CloudRegion[], w: Weights): Promise<RouteResponse> => {
    const res = await fetch('/api/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ regions: r, alpha: w.alpha, beta: w.beta, gamma: w.gamma, delta: w.delta }),
    })
    return res.json()
  }, [])

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
    setLoading(true); setReportLoading(true)
    try {
      const [aggRes, wthRes, fcRes] = await Promise.all([
        fetch('/api/aggregate'), fetch('/api/weather'), fetch('/api/forecast'),
      ])
      const agg: CloudRegion[] = await aggRes.json()
      const wth: WeatherRow[]  = await wthRes.json().catch(() => [])
      const fc: RegionForecast[] = await fcRes.json().catch(() => [])

      setWeather(wth); setForecasts(fc)
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

  useEffect(() => {
    loadAll()
    const id = setInterval(loadAll, 10 * 60 * 1000)
    return () => clearInterval(id)
  }, [loadAll])

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
  const cheapest = regions.length ? regions.reduce((a, b) => (b.price < a.price ? b : a)) : undefined
  const cleanest = regions.length ? regions.reduce((a, b) => (b.carbon < a.carbon ? b : a)) : undefined
  const spread = regions.length ? Math.max(...regions.map((r) => r.price)) - Math.min(...regions.map((r) => r.price)) : undefined
  // representative savings headline: best vs worst region for a 50 MW · 12h job
  const worstRegion = ranked.length ? ranked[ranked.length - 1] : undefined
  const repEcon = (r: CloudRegion) => { const mwh = 50 * 12 * r.pue; return { cost: mwh * r.price, co2: (mwh * r.carbon) / 1000 } }
  const repSaveUsd = best && worstRegion ? repEcon(worstRegion).cost - repEcon(best).cost : 0
  const repSaveCo2 = best && worstRegion ? repEcon(worstRegion).co2 - repEcon(best).co2 : 0
  const maxScore = Math.max(1, ...ranked.map((r) => Math.abs(r.composite_score)))
  const tempFor = (name: string) => { const w = weather.find((x) => x.region === name); return w ? `${w.temp_f}°F` : '—' }

  const recFc = forecasts.find((f) => f.region === best?.name)?.forecast ?? []
  const nowCarbon = best?.carbon ?? 0
  let timeShift: { hoursAway: number; carbon: number; pct: number } | null = null
  if (recFc.length && nowCarbon > 0) {
    const min = recFc.reduce((a, b) => (b.carbon < a.carbon ? b : a))
    const pct = Math.round(((nowCarbon - min.carbon) / nowCarbon) * 100)
    const hoursAway = Math.max(1, Math.round((new Date(min.datetime).getTime() - Date.now()) / 3_600_000))
    if (pct >= 15) timeShift = { hoursAway, carbon: min.carbon, pct }
  }

  const TABS: { key: Tab; label: string; badge?: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'router',   label: 'Routing Agent' },
    { key: 'fleet',    label: 'Fleet Autopilot', badge: 'new' },
  ]

  return (
    <div className="min-h-screen w-full text-slate-100">
      <div className="mx-auto w-full max-w-[1600px] px-5 py-6 sm:px-8">

        {/* ── Header ─────────────────────────────────────────────── */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Logo />
            <div>
              <h1 className="gm-gradient-text text-2xl font-semibold tracking-tight">GridMind</h1>
              <p className="text-xs text-slate-400">Carbon &amp; cost-aware compute routing</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <button onClick={() => setShowDev(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500/40 hover:text-emerald-300">
              <span className="font-mono text-emerald-400">{'</>'}</span> Developers
            </button>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              Live{updatedAt && <span className="text-slate-500">· {updatedAt}</span>}
            </span>
          </div>
        </header>

        {showDev && <DevPanel onClose={() => setShowDev(false)} />}

        {/* ── KPI strip ────────────────────────────────────────────── */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard label="Recommended" value={best?.name ?? '—'} sub={best ? `composite score ${best.composite_score.toFixed(1)}` : 'loading…'} accent />
          <KpiCard label="Cheapest now" value={cheapest?.name ?? '—'} sub={cheapest ? `${fmtPrice(cheapest.price)} / MWh` : ''} />
          <KpiCard label="Cleanest now" value={cleanest?.name ?? '—'} sub={cleanest ? `${cleanest.carbon} gCO₂ / kWh` : ''} />
          <KpiCard label="Arbitrage spread" value={spread != null ? `${fmtPrice(spread)}` : '—'} sub="$/MWh across regions" />
        </div>

        {/* ── Savings headline ─────────────────────────────────────── */}
        {best && worstRegion && repSaveUsd > 0 && (
          <div className="mb-6 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-5 py-3 text-sm text-slate-300">
            Routing a <span className="font-semibold text-slate-100">50 MW · 12 h</span> job to{' '}
            <span className="font-semibold text-emerald-300">{best.name}</span> right now saves about{' '}
            <span className="font-semibold text-emerald-300">{fmtMoney(repSaveUsd)}</span> and{' '}
            <span className="font-semibold text-emerald-300">{repSaveCo2.toFixed(1)} t CO₂</span> versus {worstRegion.name}.
          </div>
        )}

        {/* ── Tabs ─────────────────────────────────────────────────── */}
        <div className="mb-6 flex gap-1 border-b border-slate-800">
          {TABS.map(({ key, label, badge }) => (
            <button key={key} onClick={() => setTab(key)}
              className={`relative px-4 py-2.5 text-sm font-medium transition ${tab === key ? 'text-emerald-300' : 'text-slate-400 hover:text-slate-200'}`}>
              {label}
              {badge && <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-emerald-300">{badge}</span>}
              {tab === key && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-emerald-400" />}
            </button>
          ))}
        </div>

        {/* ── OVERVIEW ─────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div className="gm-tab grid grid-cols-1 gap-5 xl:grid-cols-12">
            <div className="space-y-5 xl:col-span-8">
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
                {/* Recommended region */}
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
                        <HeroStat label="Latency" value={`${best.latency}`} unit="ms est" tone="text-slate-100" />
                      </div>
                    </div>
                  )}
                </section>

                {/* Weighting */}
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

              {/* Region matrix */}
              <section className={`${card} overflow-hidden`}>
                <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
                  <h3 className="text-sm font-semibold text-slate-200">Region matrix</h3>
                  <span className="text-xs text-slate-500">ranked by composite score · PUE adjusts to live temperature</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-6 py-3 font-medium">Region</th>
                        <th className="px-6 py-3 font-medium">Temp</th>
                        <th className="px-6 py-3 text-right font-medium">Price $/MWh</th>
                        <th className="px-6 py-3 font-medium">Carbon gCO₂/kWh</th>
                        <th className="px-6 py-3 font-medium">Renewable</th>
                        <th className="px-6 py-3 text-right font-medium">PUE</th>
                        <th className="px-6 py-3 text-right font-medium">Latency</th>
                        <th className="px-6 py-3 font-medium">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading
                        ? Array.from({ length: 3 }).map((_, i) => (
                            <tr key={i} className="border-t border-slate-800/70">
                              {Array.from({ length: 8 }).map((__, j) => (
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
                                <td className="px-6 py-4">
                                  <div className="flex items-center gap-2">
                                    <div className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-800">
                                      <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.min(100, r.renewable_pct ?? 0)}%` }} />
                                    </div>
                                    <span className="tabular-nums text-slate-300">{r.renewable_pct ?? '—'}%</span>
                                  </div>
                                  {r.top_source && <div className="mt-0.5 text-[10px] text-slate-600">mostly {r.top_source}</div>}
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

              {/* Carbon outlook */}
              <section className={`${card} p-6`}>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-200">Carbon outlook</h3>
                  <span className="text-xs text-slate-500">{best ? `${best.name} · next 24h` : 'forecast'}</span>
                </div>
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

            {/* AI analysis — sticky */}
            <aside className="xl:col-span-4 xl:sticky xl:top-6 xl:self-start">
              <section className={`${card} flex flex-col p-6 xl:h-[calc(100vh-7rem)]`}>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-200">AI analysis</h3>
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
                    <div className="report-md gm-fade-up"><ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown></div>
                  )}
                </div>
              </section>
            </aside>
          </div>
        )}

        {/* ── ROUTING AGENT ────────────────────────────────────────── */}
        {tab === 'router' && (
          <div className="gm-tab mx-auto max-w-3xl">
            <AgentPanel />
          </div>
        )}

        {/* ── FLEET AUTOPILOT ──────────────────────────────────────── */}
        {tab === 'fleet' && <div className="gm-tab"><FleetScheduler /></div>}

        {/* ── Footer ─────────────────────────────────────────────── */}
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 pt-5 text-xs text-slate-600">
          <span>Live data · OpenWeatherMap · Electricity Maps · GridStatus.io · Anthropic</span>
          <span>GridMind</span>
        </footer>
      </div>
    </div>
  )
}

// ── small presentational components ───────────────────────────────────
function Logo() {
  return (
    <div className="relative grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 shadow-lg shadow-emerald-500/25 ring-1 ring-white/10">
      {/* routing mark: three region nodes, optimal one highlighted */}
      <svg viewBox="0 0 24 24" className="h-6 w-6 text-slate-950" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.5 16.5 L11.2 7.4" />
        <path d="M12.8 7.4 L17.5 13.5" />
        <circle cx="5" cy="18" r="1.9" fill="currentColor" stroke="none" />
        <circle cx="19" cy="15" r="1.9" fill="currentColor" stroke="none" />
        <circle cx="12" cy="6" r="2.6" fill="currentColor" stroke="none" />
        <circle cx="12" cy="6" r="2.6" fill="none" className="text-emerald-50/70" />
      </svg>
    </div>
  )
}

function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`gm-card px-4 py-3 ${accent ? 'ring-1 ring-emerald-500/25' : ''}`}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 truncate text-lg font-semibold ${accent ? 'text-emerald-300' : 'text-slate-100'}`}>{value}</p>
      {sub && <p className="truncate text-[11px] tabular-nums text-slate-500">{sub}</p>}
    </div>
  )
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
