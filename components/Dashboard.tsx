'use client'

import { useState, useEffect, useRef } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'

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

type WeatherRow = {
  region: string
  temp_f: number
}

const WEIGHT_META = [
  { label: 'Cost (α)',       key: 'alpha' as const },
  { label: 'Efficiency (β)', key: 'beta'  as const },
  { label: 'Carbon (γ)',     key: 'gamma' as const },
]

export default function Dashboard() {
  const [alpha, setAlpha] = useState(0.4)
  const [beta,  setBeta]  = useState(0.3)
  const [gamma, setGamma] = useState(0.3)

  const [regions,     setRegions]     = useState<CloudRegion[]>([])
  const [weather,     setWeather]     = useState<WeatherRow[]>([])
  const [routeResult, setRouteResult] = useState<RouteResponse | null>(null)
  const [report,           setReport]          = useState('')
  const [displayedReport,  setDisplayedReport] = useState('')
  const [telemetry, setTelemetry] = useState<{ js: number; wasm: number | null }>({ js: 0, wasm: null })
  const [loading, setLoading] = useState(true)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Refs keep debounce callback reading current weights without stale closures
  const aRef = useRef(alpha)
  const bRef = useRef(beta)
  const gRef = useRef(gamma)
  useEffect(() => { aRef.current = alpha }, [alpha])
  useEffect(() => { bRef.current = beta  }, [beta])
  useEffect(() => { gRef.current = gamma }, [gamma])

  async function callRoute(r: CloudRegion[], a: number, b: number, g: number): Promise<RouteResponse> {
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ regions: r, alpha: a, beta: b, gamma: g }),
    })
    return res.json()
  }

  async function loadAll() {
    setLoading(true)
    try {
      const [aggRes, wthRes] = await Promise.all([
        fetch('/api/aggregate'),
        fetch('/api/weather'),
      ])
      const agg: CloudRegion[] = await aggRes.json()
      const wth: WeatherRow[]  = await wthRes.json()

      const route = await callRoute(agg, aRef.current, bRef.current, gRef.current)

      const scoreMap = new Map(route.top3.map((r) => [r.name, r.composite_score]))
      const scored   = agg.map((r) => ({ ...r, composite_score: scoreMap.get(r.name) ?? 0 }))

      const analyzeRes = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recommendation: route.recommendation,
          top3:           route.top3,
          scores:         route.scores,
        }),
      })
      const { report: newReport = '' } = await analyzeRes.json()

      setRegions(scored)
      setWeather(wth)
      setRouteResult(route)
      setReport(newReport)
      runBenchmark()
    } catch (err) {
      console.error('[Dashboard] loadAll', err)
    } finally {
      setLoading(false)
    }
  }

  async function runBenchmark() {
    const a = aRef.current, b = bRef.current, g = gRef.current

    const t0 = performance.now()
    for (let i = 0; i < 100; i++) { void (a * 45.5 + b * 1.55 + g * 234) }
    const jsMs = performance.now() - t0

    try {
      // @ts-expect-error: Emscripten output in /public — not in TS module registry
      const factory = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ '/scorer.js')
      const m       = await (factory.default ?? factory)()
      const matcher = new m.GridMatcher()
      const t1 = performance.now()
      for (let i = 0; i < 100; i++) { matcher.calculate_score(45.5, 1.55, 234, a, b, g) }
      const wasmMs = performance.now() - t1
      matcher.delete()
      setTelemetry({ js: jsMs, wasm: wasmMs })
    } catch {
      setTelemetry({ js: jsMs, wasm: null })
    }
  }

  // Initial load + 10-minute auto-refresh
  useEffect(() => {
    loadAll()
    const id = setInterval(loadAll, 10 * 60 * 1000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Typewriter effect for Claude report
  useEffect(() => {
    if (!report) return
    let i = 0
    setDisplayedReport('')
    const id = setInterval(() => {
      i++
      setDisplayedReport(report.slice(0, i))
      if (i >= report.length) clearInterval(id)
    }, 12)
    return () => clearInterval(id)
  }, [report])

  function handleWeightChange(key: 'alpha' | 'beta' | 'gamma', value: number) {
    if (key === 'alpha') setAlpha(value)
    if (key === 'beta')  setBeta(value)
    if (key === 'gamma') setGamma(value)

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      if (!regions.length) return
      try {
        const route = await callRoute(regions, aRef.current, bRef.current, gRef.current)
        const scoreMap = new Map(route.top3.map((r) => [r.name, r.composite_score]))
        setRegions((prev) =>
          prev.map((r) => ({ ...r, composite_score: scoreMap.get(r.name) ?? r.composite_score }))
        )
        setRouteResult(route)
      } catch (err) {
        console.error('[Dashboard] route', err)
      }
    }, 300)
  }

  const weightValues: Record<'alpha' | 'beta' | 'gamma', number> = { alpha, beta, gamma }

  function tempFor(name: string) {
    const row = weather.find((w) => w.region === name)
    return row ? `${row.temp_f}°F` : '—'
  }

  function efficiencyIndex(r: CloudRegion) {
    return r.composite_score > 0 ? (1000 / r.composite_score).toFixed(2) : '—'
  }

  const telemetryData = [
    { name: 'JS',   ms: telemetry.js },
    ...(telemetry.wasm !== null ? [{ name: 'WASM', ms: telemetry.wasm }] : []),
  ]

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6 font-mono">
      <h1 className="text-2xl font-bold mb-6 text-green-400">GridMind — Compute Router</h1>

      {/* Control Panel */}
      <section aria-label="Control Panel" className="mb-8 bg-gray-800 rounded-lg p-5">
        <h2 className="text-lg font-semibold mb-4 text-gray-300">Control Panel</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {WEIGHT_META.map(({ label, key }) => (
            <div key={key}>
              <label htmlFor={`slider-${key}`} className="block text-sm text-gray-400 mb-1">
                {label}:{' '}
                <span className="text-white font-medium">{weightValues[key].toFixed(2)}</span>
              </label>
              <input
                id={`slider-${key}`}
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={weightValues[key]}
                onChange={(e) => handleWeightChange(key, parseFloat(e.target.value))}
                className="w-full accent-green-400 cursor-pointer"
              />
            </div>
          ))}
        </div>
      </section>

      {/* Region Matrix */}
      <section aria-label="Region Matrix" className="mb-8 bg-gray-800 rounded-lg p-5 overflow-x-auto">
        <h2 className="text-lg font-semibold mb-4 text-gray-300">Region Matrix</h2>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-gray-400 border-b border-gray-700">
              {['Region', 'Temp', 'Price ($/MWh)', 'PUE', 'Carbon (gCO₂/kWh)', 'Efficiency Index'].map((h) => (
                <th key={h} scope="col" className="py-2 pr-6 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="border-b border-gray-700">
                    {Array.from({ length: 6 }).map((__, j) => (
                      <td key={j} className="py-3 pr-6">
                        <div className="h-4 bg-gray-700 rounded w-16 animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              : regions.map((r) => (
                  <tr
                    key={r.name}
                    className={`border-b border-gray-700 transition-colors ${
                      routeResult?.recommendation === r.name
                        ? 'bg-green-900/20'
                        : 'hover:bg-gray-700/40'
                    }`}
                  >
                    <td className="py-3 pr-6 font-medium text-green-400">
                      {r.name}
                      {routeResult?.recommendation === r.name && (
                        <span
                          className="ml-2 text-xs bg-green-700 text-green-100 px-1.5 py-0.5 rounded"
                          aria-label="recommended"
                        >
                          ✓
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-6 tabular-nums">{tempFor(r.name)}</td>
                    <td className="py-3 pr-6 tabular-nums">{r.price.toFixed(2)}</td>
                    <td className="py-3 pr-6 tabular-nums">{r.pue.toFixed(2)}</td>
                    <td className="py-3 pr-6 tabular-nums">{r.carbon}</td>
                    <td className="py-3 tabular-nums">{efficiencyIndex(r)}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </section>

      {/* Telemetry */}
      <section aria-label="Telemetry" className="mb-8 bg-gray-800 rounded-lg p-5">
        <h2 className="text-lg font-semibold mb-4 text-gray-300">
          Telemetry — calculate_score ×100
        </h2>
        <div className="flex flex-col sm:flex-row gap-6 items-start">
          <div className="flex gap-4 flex-shrink-0">
            {[
              { label: 'JavaScript', value: telemetry.js.toFixed(3),   color: 'text-yellow-400' },
              { label: 'WASM',       value: telemetry.wasm !== null ? telemetry.wasm.toFixed(3) : '—', color: 'text-blue-400' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-gray-900 rounded p-4 text-center min-w-[90px]">
                <div className="text-xs text-gray-400 mb-1">{label}</div>
                <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
                <div className="text-xs text-gray-500 mt-0.5">ms</div>
              </div>
            ))}
          </div>
          {telemetryData.length > 0 && (
            <div className="w-full sm:flex-1 h-28" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={telemetryData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} unit="ms" width={52} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6, color: '#fff', fontSize: 12 }}
                    formatter={(v) => [`${Number(v).toFixed(4)} ms`, 'time'] as [string, string]}
                    cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  />
                  <Bar dataKey="ms" radius={[4, 4, 0, 0]} maxBarSize={48}>
                    {telemetryData.map((entry) => (
                      <Cell key={entry.name} fill={entry.name === 'JS' ? '#facc15' : '#60a5fa'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </section>

      {/* Terminal */}
      <section aria-label="Claude Arbitrage Report" className="bg-gray-800 rounded-lg p-5">
        <h2 className="text-lg font-semibold mb-3 text-gray-300">
          Claude Arbitrage Report
          {routeResult?.recommendation && (
            <span className="ml-3 text-sm font-normal text-green-400">
              → {routeResult.recommendation}
            </span>
          )}
        </h2>
        <div
          role="log"
          aria-live="polite"
          aria-label="Streaming analysis report"
          className="bg-gray-950 rounded p-4 min-h-[180px] text-green-300 text-sm leading-relaxed whitespace-pre-wrap break-words"
        >
          {loading && !displayedReport
            ? <span className="text-gray-500 animate-pulse">Initializing…</span>
            : <>
                {displayedReport}
                {displayedReport.length < report.length && (
                  <span className="animate-pulse text-green-400" aria-hidden="true">█</span>
                )}
              </>
          }
        </div>
      </section>
    </div>
  )
}
