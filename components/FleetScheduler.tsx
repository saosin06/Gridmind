'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Status = 'queued' | 'deferred' | 'running' | 'done'
type Job = {
  id: string
  name: string
  mw: number
  hours: number
  flexible: boolean
  profile: string
  status: Status
  region?: string
  defer_hours?: number
  run_at_hour?: number
  savings_usd?: number
  savings_co2?: number
  reason?: string
}
type Plan = {
  id: string; region: string; run_now: boolean; defer_hours: number
  savings_usd: number; savings_co2: number; reason: string
}

const PROFILES = ['training', 'inference', 'batch', 'balanced']
const TICK_MS = 1600    // each tick = 1 simulated hour
const BRIEF_EVERY = 6   // auto operator briefing every N simulated hours

let seq = 0
const uid = () => `job_${++seq}`

const SEED: Omit<Job, 'status'>[] = [
  { id: uid(), name: 'llama-finetune-A', mw: 80, hours: 18, flexible: true,  profile: 'training' },
  { id: uid(), name: 'rt-inference-eu',  mw: 20, hours: 6,  flexible: false, profile: 'inference' },
  { id: uid(), name: 'etl-nightly',      mw: 15, hours: 8,  flexible: true,  profile: 'batch' },
  { id: uid(), name: 'embeddings-batch', mw: 40, hours: 10, flexible: true,  profile: 'batch' },
]

const fmtMoney = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`
const STATUS_STYLE: Record<Status, string> = {
  queued:   'bg-slate-700/60 text-slate-300',
  deferred: 'bg-amber-500/15 text-amber-300',
  running:  'bg-blue-500/15 text-blue-300',
  done:     'bg-emerald-500/15 text-emerald-300',
}

export default function FleetScheduler() {
  const [jobs, setJobs] = useState<Job[]>(SEED.map((j) => ({ ...j, status: 'queued' as const })))
  const [simHour, setSimHour] = useState(0)
  const [autopilot, setAutopilot] = useState(false)
  const [log, setLog] = useState<{ hour: number; text: string; tone: 'route' | 'run' | 'done' }[]>([])
  const [totals, setTotals] = useState({ usd: 0, co2: 0, completed: 0 })
  const [maxCarbon, setMaxCarbon] = useState('')
  const [briefing, setBriefing] = useState('')
  const [briefingAt, setBriefingAt] = useState<number | null>(null)
  const [briefingBusy, setBriefingBusy] = useState(false)

  const jobsRef = useRef(jobs); useEffect(() => { jobsRef.current = jobs }, [jobs])
  const hourRef = useRef(simHour); useEffect(() => { hourRef.current = simHour }, [simHour])
  const totalsRef = useRef(totals); useEffect(() => { totalsRef.current = totals }, [totals])
  const logRef = useRef(log); useEffect(() => { logRef.current = log }, [log])
  const ticking = useRef(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const briefingBusyRef = useRef(false)
  const lastBriefHour = useRef(0)

  const card = 'gm-card'
  const addLog = (text: string, tone: 'route' | 'run' | 'done') =>
    setLog((l) => [{ hour: hourRef.current, text, tone }, ...l].slice(0, 60))

  // Operator briefing — LLM (Sonnet) summary, off the hot path
  const generateBriefing = useCallback(async () => {
    if (briefingBusyRef.current) return
    briefingBusyRef.current = true
    setBriefingBusy(true)
    try {
      const js = jobsRef.current
      const res = await fetch('/api/briefing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sim_hour: hourRef.current,
          totals: totalsRef.current,
          queue: {
            pending: js.filter((j) => j.status !== 'done').length,
            running: js.filter((j) => j.status === 'running').length,
            deferred: js.filter((j) => j.status === 'deferred').length,
            done: js.filter((j) => j.status === 'done').length,
          },
          recent_activity: logRef.current.slice(0, 12).map((e) => `T+${e.hour}h ${e.text}`),
        }),
      })
      const { briefing: b } = await res.json()
      if (b) { setBriefing(b); setBriefingAt(hourRef.current) }
    } catch (err) {
      console.error('[FleetScheduler] briefing', err)
    } finally {
      briefingBusyRef.current = false
      setBriefingBusy(false)
    }
  }, [])

  const tick = useCallback(async () => {
    if (ticking.current) return
    ticking.current = true
    try {
      const hour = hourRef.current + 1
      setSimHour(hour)

      // 1. route any queued jobs (one batch call to the deterministic router)
      const queued = jobsRef.current.filter((j) => j.status === 'queued')
      if (queued.length) {
        const policy: Record<string, unknown> = {}
        if (maxCarbon.trim() !== '') policy.max_carbon = Number(maxCarbon)
        try {
          const res = await fetch('/api/schedule', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jobs: queued.map((j) => ({ id: j.id, mw: j.mw, hours: j.hours, flexible: j.flexible, profile: j.profile })),
              policy,
            }),
          })
          const { plans }: { plans: Plan[] } = await res.json()
          const byId = new Map(plans.map((p) => [p.id, p]))
          setJobs((prev) => prev.map((j) => {
            const p = byId.get(j.id)
            if (!p || j.status !== 'queued') return j
            const deferred = !p.run_now && p.defer_hours > 0
            addLog(`Routed ${j.name} → ${p.region}${deferred ? ` · defer ${p.defer_hours}h` : ' · now'}`, 'route')
            return {
              ...j, region: p.region, defer_hours: p.defer_hours, reason: p.reason,
              savings_usd: p.savings_usd, savings_co2: p.savings_co2,
              status: deferred ? 'deferred' : 'running',
              run_at_hour: deferred ? hour + p.defer_hours : hour,
            }
          }))
        } catch (err) { console.error('[FleetScheduler] schedule', err) }
      }

      // 2. deferred jobs whose window arrived → running
      setJobs((prev) => prev.map((j) => {
        if (j.status === 'deferred' && (j.run_at_hour ?? Infinity) <= hour) {
          addLog(`Starting ${j.name} in ${j.region}`, 'run')
          return { ...j, status: 'running' as const }
        }
        return j
      }))

      // 3. running jobs → done (+ bank savings)
      setJobs((prev) => prev.map((j) => {
        if (j.status === 'running' && (j.run_at_hour ?? hour) < hour) {
          addLog(`Completed ${j.name} — saved ${fmtMoney(j.savings_usd ?? 0)} · ${(j.savings_co2 ?? 0).toFixed(1)}t CO₂`, 'done')
          setTotals((t) => ({ usd: t.usd + (j.savings_usd ?? 0), co2: t.co2 + (j.savings_co2 ?? 0), completed: t.completed + 1 }))
          return { ...j, status: 'done' as const }
        }
        return j
      }))

      // 4. periodic operator briefing (LLM summary, off the hot path)
      if (logRef.current.length && hour - lastBriefHour.current >= BRIEF_EVERY) {
        lastBriefHour.current = hour
        void generateBriefing()
      }
    } finally {
      ticking.current = false
    }
  }, [maxCarbon, generateBriefing])

  useEffect(() => {
    if (!autopilot) { if (timer.current) clearInterval(timer.current); return }
    timer.current = setInterval(tick, TICK_MS)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [autopilot, tick])

  const pending = jobs.filter((j) => j.status !== 'done').length
  function addJob(profile: string) {
    const n = jobs.length + 1
    setJobs((prev) => [...prev, {
      id: uid(), name: `${profile}-job-${n}`, status: 'queued',
      mw: 10 + Math.round((n * 37) % 80), hours: 4 + ((n * 5) % 14),
      flexible: profile !== 'inference', profile,
    }])
  }
  function reset() {
    seq = 0
    setAutopilot(false); setSimHour(0); setLog([]); setTotals({ usd: 0, co2: 0, completed: 0 })
    setBriefing(''); setBriefingAt(null); lastBriefHour.current = 0
    setJobs(SEED.map((j) => ({ ...j, id: uid(), status: 'queued' as const })))
  }

  return (
    <div className="space-y-5">
      {/* Header / controls */}
      <section className={`${card} p-6`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
              Fleet Autopilot
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">autonomous</span>
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Continuously routes queued jobs to the cheapest/cleanest region & time, within policy.
              {' '}<span className="text-slate-600">Simulated clock · T+{simHour}h</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              max carbon
              <input type="number" min={0} placeholder="—" value={maxCarbon} onChange={(e) => setMaxCarbon(e.target.value)}
                className="w-20 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200 outline-none focus:border-emerald-500/50" />
            </label>
            <button onClick={() => setAutopilot((a) => !a)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${autopilot ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30' : 'bg-gradient-to-r from-emerald-500 to-teal-600 text-slate-950 hover:brightness-110'}`}>
              {autopilot ? '⏸ Pause' : '▶ Start autopilot'}
            </button>
            <button onClick={reset} className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-slate-200">Reset</button>
          </div>
        </div>

        {/* Totals */}
        <div className="mt-5 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800">
          <Totl label="Cumulative savings" value={fmtMoney(totals.usd)} tone="text-emerald-300" />
          <Totl label="CO₂ avoided" value={`${totals.co2.toFixed(1)} t`} tone="text-emerald-300" />
          <Totl label="Jobs completed" value={`${totals.completed}`} sub={`${pending} pending`} tone="text-slate-100" />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <span className="self-center text-xs text-slate-500">add job:</span>
          {PROFILES.map((p) => (
            <button key={p} onClick={() => addJob(p)}
              className="rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500/40 hover:text-emerald-300">
              + {p}
            </button>
          ))}
        </div>
      </section>

      {/* Operator briefing (LLM) */}
      <section className={`${card} p-6`}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            Operator briefing
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">Claude · Sonnet</span>
            {briefingAt != null && <span className="text-[10px] font-normal text-slate-600">updated T+{briefingAt}h</span>}
          </h3>
          <button onClick={() => generateBriefing()} disabled={briefingBusy}
            className="rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40">
            {briefingBusy ? 'briefing…' : 'Brief now'}
          </button>
        </div>
        <div className="rounded-lg border border-slate-800 bg-[#0a111c] p-4">
          {briefing
            ? <div className="report-md gm-fade-up"><ReactMarkdown remarkPlugins={[remarkGfm]}>{briefing}</ReactMarkdown></div>
            : <p className="text-xs text-slate-500">{briefingBusy ? 'Generating briefing…' : 'The operations lead summarizes fleet activity here as the autopilot runs (auto every few hours, or press Brief now).'}</p>}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Job queue */}
        <section className={`lg:col-span-2 ${card} overflow-hidden`}>
          <div className="border-b border-slate-800 px-6 py-4 text-sm font-semibold text-slate-200">Job queue</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-6 py-3 font-medium">Job</th>
                  <th className="px-6 py-3 font-medium">Profile</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Region</th>
                  <th className="px-6 py-3 text-right font-medium">Saved</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t border-slate-800/70">
                    <td className="px-6 py-3">
                      <div className="font-medium text-slate-200">{j.name}</div>
                      <div className="text-[11px] text-slate-500">{j.mw} MW · {j.hours}h · {j.flexible ? 'flexible' : 'fixed'}</div>
                    </td>
                    <td className="px-6 py-3 text-slate-400">{j.profile}</td>
                    <td className="px-6 py-3">
                      <span className={`rounded px-2 py-0.5 text-[11px] capitalize ${STATUS_STYLE[j.status]}`}>
                        {j.status}{j.status === 'deferred' && j.defer_hours ? ` ${j.defer_hours}h` : ''}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-slate-300">{j.region ?? '—'}</td>
                    <td className="px-6 py-3 text-right tabular-nums text-emerald-300">{j.savings_usd != null ? fmtMoney(j.savings_usd) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Activity log */}
        <section className={`${card} flex flex-col p-6`}>
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Activity</h3>
          <div className="flex-1 space-y-1.5 overflow-y-auto" style={{ maxHeight: 360 }}>
            {!log.length && <p className="text-xs text-slate-500">Press <span className="text-emerald-300">Start autopilot</span> — the agent will route the queue.</p>}
            {log.map((e, i) => (
              <div key={i} className="gm-fade-up flex gap-2 text-xs">
                <span className="tabular-nums text-slate-600">T+{e.hour}h</span>
                <span className={e.tone === 'done' ? 'text-emerald-300' : e.tone === 'run' ? 'text-blue-300' : 'text-slate-400'}>{e.text}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function Totl({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: string }) {
  return (
    <div className="bg-slate-900 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-600">{sub}</p>}
    </div>
  )
}
