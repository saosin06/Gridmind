'use client'

import { useState, useEffect, useRef } from 'react'
import { REGIONS, USER_LOCATIONS } from '../lib/gridmind/regions'

type Considered = {
  region: string; score: number; price: number; carbon: number; latency: number
  status: 'chosen' | 'candidate' | 'excluded'; excluded_reason?: string
}
type DecideResult = {
  ok: boolean
  reason?: string
  recommendation?: { region: string; run_now: boolean; defer_hours: number; defer_until: string | null }
  projected?: {
    energy_cost_usd: number; co2_tonnes: number
    savings_vs_worst_usd: number; savings_vs_worst_co2_tonnes: number; baseline_region: string
  }
  rationale?: string
  considered?: Considered[]
  trace?: { tool: string; label: string }[]
  audit?: { model: string; iterations: number }
}

const PROFILES = [
  { key: 'training',  label: 'Training' },
  { key: 'inference', label: 'Inference' },
  { key: 'batch',     label: 'Batch' },
  { key: 'balanced',  label: 'Balanced' },
]
const REGION_NAMES = REGIONS.map((r) => r.name)
const fmtMoney = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`

type Phase = 'idle' | 'running' | 'revealing' | 'done'

export default function AgentPanel() {
  const [mw, setMw] = useState(50)
  const [hours, setHours] = useState(12)
  const [flexible, setFlexible] = useState(true)
  const [profile, setProfile] = useState('training')
  const [userLoc, setUserLoc] = useState('us-east')
  const [maxCarbon, setMaxCarbon] = useState<string>('')
  const [allowed, setAllowed] = useState<string[]>(REGION_NAMES)

  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<DecideResult | null>(null)
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState(0)
  const [prState, setPrState] = useState<'idle' | 'opening' | 'opened' | 'error'>('idle')
  const [pr, setPr] = useState<{ url: string; number: number } | null>(null)
  const [prError, setPrError] = useState('')
  const [flyState, setFlyState] = useState<'idle' | 'opening' | 'opened' | 'error'>('idle')
  const [fly, setFly] = useState<{ machine_id: string; region: string; dashboard: string } | null>(null)
  const [flyError, setFlyError] = useState('')
  const card = 'gm-card'

  function toggleRegion(name: string) {
    setAllowed((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
  }

  async function run() {
    setPhase('running'); setResult(null); setError(''); setRevealed(0)
    setPrState('idle'); setPr(null); setPrError('')
    setFlyState('idle'); setFly(null); setFlyError('')
    const policy: Record<string, unknown> = {}
    if (maxCarbon.trim() !== '') policy.max_carbon = Number(maxCarbon)
    if (allowed.length < REGION_NAMES.length) policy.allowed_regions = allowed
    try {
      const res = await fetch('/api/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workload: { mw, hours, flexible },
          priorities: profile,
          user_location: userLoc,
          policy,
        }),
      })
      const data: DecideResult = await res.json()
      setResult(data)
      setPhase('revealing')
    } catch (err) {
      console.error('[AgentPanel]', err)
      setError('Agent request failed.')
      setPhase('idle')
    }
  }

  // reveal trace steps one-by-one for the "agent reasoning" effect
  useEffect(() => {
    if (phase !== 'revealing' || !result?.trace) return
    if (revealed >= result.trace.length) { const t = setTimeout(() => setPhase('done'), 350); return () => clearTimeout(t) }
    const t = setTimeout(() => setRevealed((n) => n + 1), 600)
    return () => clearTimeout(t)
  }, [phase, revealed, result])

  const rec = result?.recommendation
  const proj = result?.projected
  const running = phase === 'running' || phase === 'revealing'

  // Real action (human-approval-gated): open a GitHub PR with the deployment manifest
  async function openPr() {
    if (!rec || !proj) return
    setPrState('opening'); setPrError('')
    try {
      const res = await fetch('/api/deploy-pr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workload: { name: `${profile}-${mw}mw-${hours}h`, mw, hours, profile },
          region: rec.region, run_now: rec.run_now, defer_until: rec.defer_until,
          projected: proj, rationale: result?.rationale ?? '',
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) { setPrError(data.error || 'Failed to open PR'); setPrState('error'); return }
      setPr({ url: data.url, number: data.number }); setPrState('opened')
    } catch (err) {
      console.error('[AgentPanel] openPr', err); setPrError('Request failed'); setPrState('error')
    }
  }

  // Real action: boot an actual Fly.io machine in the chosen region
  async function openFly() {
    if (!rec) return
    setFlyState('opening'); setFlyError('')
    try {
      const res = await fetch('/api/deploy-fly', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ region: rec.region, workload: { name: `${profile}-${mw}mw-${hours}h` } }),
      })
      const data = await res.json()
      if (!res.ok || data.error) { setFlyError(data.error || 'Fly deploy failed'); setFlyState('error'); return }
      setFly({ machine_id: data.machine_id, region: data.region, dashboard: data.dashboard }); setFlyState('opened')
    } catch (err) {
      console.error('[AgentPanel] openFly', err); setFlyError('Request failed'); setFlyState('error')
    }
  }

  return (
    <section className={`${card} p-6`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-emerald-500/15 text-emerald-300">⚡</span>
          <h3 className="text-sm font-semibold text-slate-100">Routing Agent</h3>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">Claude · live data</span>
        </div>
        {phase !== 'idle' && (
          <button onClick={() => { setPhase('idle'); setResult(null); setPrState('idle'); setPr(null); setFlyState('idle'); setFly(null) }} className="rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-200">New</button>
        )}
      </div>

      {/* ── Form ── */}
      {phase === 'idle' && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Load (MW)"><input type="number" min={1} max={500} value={mw} onChange={(e) => setMw(Math.max(1, Number(e.target.value) || 1))} className="num" /></Field>
            <Field label="Duration (h)"><input type="number" min={1} max={720} value={hours} onChange={(e) => setHours(Math.max(1, Number(e.target.value) || 1))} className="num" /></Field>
            <label className="flex items-center gap-2 pb-2 text-sm text-slate-300">
              <input type="checkbox" checked={flexible} onChange={(e) => setFlexible(e.target.checked)} className="accent-emerald-500" /> Flexible (may defer)
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <Field label="Profile"><select value={profile} onChange={(e) => setProfile(e.target.value)} className="sel">{PROFILES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
            <Field label="Users in"><select value={userLoc} onChange={(e) => setUserLoc(e.target.value)} className="sel">{USER_LOCATIONS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</select></Field>
            <Field label="Max carbon (gCO₂)"><input type="number" min={0} placeholder="none" value={maxCarbon} onChange={(e) => setMaxCarbon(e.target.value)} className="num" /></Field>
          </div>
          <div>
            <p className="mb-1.5 text-xs text-slate-400">Allowed regions (policy)</p>
            <div className="flex flex-wrap gap-2">
              {REGION_NAMES.map((n) => (
                <button key={n} onClick={() => toggleRegion(n)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition ${allowed.includes(n) ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-800/40 text-slate-500'}`}>
                  {allowed.includes(n) ? '✓ ' : ''}{n}
                </button>
              ))}
            </div>
          </div>
          <button onClick={run} disabled={!allowed.length}
            className="w-full rounded-lg bg-gradient-to-r from-emerald-500 to-teal-600 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-40">
            ⚡ Run routing agent
          </button>
          {error && <p className="text-xs text-rose-400">{error}</p>}
        </div>
      )}

      {/* ── Reasoning trace ── */}
      {phase !== 'idle' && (
        <div className="mt-4">
          <div className="rounded-lg border border-slate-800 bg-[#0a111c] p-4">
            {phase === 'running' && (
              <p className="flex items-center gap-2 text-sm text-slate-400">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-400" />
                Agent reasoning over live grid data…
              </p>
            )}
            {result?.trace?.slice(0, revealed).map((t, i) => (
              <div key={i} className="gm-fade-up flex items-start gap-2 py-1 text-sm">
                <span className="text-emerald-400">{t.tool === 'policy' && t.label.startsWith('Excluded') ? '✕' : t.tool === 'submit_decision' ? '◆' : '✓'}</span>
                <span className="text-slate-300">{t.label}</span>
              </div>
            ))}
            {phase === 'revealing' && result?.trace && revealed < result.trace.length && (
              <div className="flex items-center gap-2 py-1 text-sm text-slate-500">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-700 border-t-emerald-400" />…
              </div>
            )}
          </div>

          {/* ── Decision ── */}
          {phase === 'done' && result && (
            result.ok && rec && proj ? (
              <div className="gm-fade-up mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-lg font-semibold text-slate-100">
                    Route to <span className="text-emerald-300">{rec.region}</span>
                    <span className="ml-2 text-sm font-normal text-slate-400">{rec.run_now ? 'run now' : `defer ${rec.defer_hours}h`}</span>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Stat label="Energy cost" value={fmtMoney(proj.energy_cost_usd)} tone={proj.energy_cost_usd < 0 ? 'text-emerald-300' : 'text-slate-100'} />
                  <Stat label="Carbon" value={`${proj.co2_tonnes} t`} tone="text-slate-100" />
                  <Stat label={`Saves vs ${proj.baseline_region}`} value={`${fmtMoney(proj.savings_vs_worst_usd)} · ${proj.savings_vs_worst_co2_tonnes}t`} tone="text-emerald-300" />
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-400">{result.rationale}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {result.considered?.map((c) => (
                    <span key={c.region} className={`rounded px-2 py-0.5 text-[11px] ${c.status === 'chosen' ? 'bg-emerald-500/20 text-emerald-300' : c.status === 'excluded' ? 'bg-slate-800 text-slate-600 line-through' : 'bg-slate-800 text-slate-400'}`}
                      title={c.excluded_reason ?? ''}>{c.region}</span>
                  ))}
                </div>

                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {/* GitOps PR */}
                  {prState === 'opened' && pr ? (
                    <a href={pr.url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center justify-between rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300 transition hover:bg-emerald-500/20">
                      <span>✓ PR #{pr.number}</span><span className="text-xs text-emerald-400/70">GitHub →</span>
                    </a>
                  ) : (
                    <button onClick={openPr} disabled={prState === 'opening'}
                      className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50">
                      {prState === 'opening' ? 'Opening PR…' : '🚀 Open deployment PR'}
                    </button>
                  )}
                  {/* Fly real deploy */}
                  {flyState === 'opened' && fly ? (
                    <a href={fly.dashboard} target="_blank" rel="noopener noreferrer"
                      className="flex items-center justify-between rounded-lg border border-teal-500/40 bg-teal-500/10 px-4 py-2 text-sm text-teal-200 transition hover:bg-teal-500/20">
                      <span>✓ Live in {fly.region}</span><span className="text-xs text-teal-300/70">Fly →</span>
                    </a>
                  ) : (
                    <button onClick={openFly} disabled={flyState === 'opening'}
                      className="rounded-lg border border-teal-500/40 bg-teal-500/10 px-4 py-2 text-sm font-medium text-teal-200 transition hover:bg-teal-500/20 disabled:opacity-50">
                      {flyState === 'opening' ? 'Deploying…' : '⚡ Deploy to Fly (real)'}
                    </button>
                  )}
                </div>
                {(prState === 'error' || flyState === 'error') && (
                  <p className="mt-2 text-xs text-rose-400">{prError || flyError}</p>
                )}
              </div>
            ) : (
              <div className="gm-fade-up mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300">
                {result.reason ?? 'No decision returned.'}
              </div>
            )
          )}
        </div>
      )}

      <style jsx>{`
        .num, .sel { background:#1e293b; border:1px solid #334155; border-radius:8px; padding:6px 10px; font-size:14px; color:#e2e8f0; outline:none; }
        .num { width:96px; }
        .num:focus, .sel:focus { border-color:rgba(16,185,129,.5); }
      `}</style>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs text-slate-400">{label}</span>{children}</label>
}
function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg bg-slate-900/60 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  )
}
