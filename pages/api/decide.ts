import type { NextApiRequest, NextApiResponse } from 'next'
import Anthropic from '@anthropic-ai/sdk'
import { getRegions, getForecast, type RegionForecast } from '../../lib/gridmind/data'
import {
  withLatency, rankRegions,
  PRESETS, DEFAULT_WEIGHTS, type Weights,
} from '../../lib/gridmind/scoring'
import { estimateCost } from '../../lib/gridmind/economics'

// Single-call agent: all data is pre-loaded into the prompt so the model decides
// in ONE forced tool call (no read-tool round-trips, no adaptive thinking) → fast.
export const config = { maxDuration: 30 }

const MODEL = 'claude-sonnet-4-6'
const EFFORT = 'low'

type Policy = {
  allowed_regions?: string[]
  max_latency_ms?: number
  max_carbon?: number
}
type DecideBody = {
  workload: { name?: string; mw: number; hours: number; flexible?: boolean; deadline?: string }
  priorities?: string | Partial<Weights>
  policy?: Policy
  user_location?: string
}

type TraceStep = { tool: string; label: string }
type Decision = { region: string; run_now: boolean; defer_hours: number; rationale: string }
type Considered = {
  region: string; score: number; price: number; carbon: number; latency: number
  status: 'chosen' | 'candidate' | 'excluded'; excluded_reason?: string
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d

function resolveWeights(p: DecideBody['priorities']): Weights {
  if (typeof p === 'string') return PRESETS[p] ?? DEFAULT_WEIGHTS
  if (p && typeof p === 'object') {
    return {
      alpha: p.alpha ?? DEFAULT_WEIGHTS.alpha,
      beta: p.beta ?? DEFAULT_WEIGHTS.beta,
      gamma: p.gamma ?? DEFAULT_WEIGHTS.gamma,
      delta: p.delta ?? DEFAULT_WEIGHTS.delta,
    }
  }
  return DEFAULT_WEIGHTS
}

// forecasted carbon ~h hours ahead for a region (falls back to live carbon)
function carbonAt(fc: RegionForecast | undefined, hoursAhead: number, live: number): number {
  if (!fc || !fc.forecast.length || hoursAhead <= 0) return live
  const idx = Math.min(fc.forecast.length - 1, hoursAhead - 1)
  return fc.forecast[idx]?.carbon ?? live
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as DecideBody
  const mw = Number(body?.workload?.mw)
  const hours = Number(body?.workload?.hours)
  if (!Number.isFinite(mw) || !Number.isFinite(hours) || mw <= 0 || hours <= 0) {
    res.status(400).json({ error: 'workload.mw and workload.hours must be positive numbers' })
    return
  }
  const flexible = body.workload.flexible ?? true
  const userLoc = body.user_location ?? 'us-east'
  const weights = resolveWeights(body.priorities)
  const policy: Policy = body.policy ?? {}

  // ── 1. Pre-fetch ONE snapshot; every tool reads from it (consistency + speed)
  const [base, forecasts] = await Promise.all([getRegions(), getForecast()])
  const scored = rankRegions(withLatency(base, userLoc), weights)
  const fcFor = (name: string) => forecasts.find((f) => f.region === name)
  const nowMs = Date.now()

  // ── 2. Apply policy as a hard filter (guardrail in CODE, not the prompt)
  const considered: Considered[] = scored.map((r) => {
    let excluded: string | undefined
    if (policy.allowed_regions && !policy.allowed_regions.includes(r.name)) excluded = 'not in allowed_regions'
    else if (policy.max_latency_ms != null && r.latency > policy.max_latency_ms) excluded = `latency ${r.latency}ms > ${policy.max_latency_ms}ms`
    else if (policy.max_carbon != null && r.carbon > policy.max_carbon) excluded = `carbon ${r.carbon} > ${policy.max_carbon}`
    return {
      region: r.name, score: r.composite_score, price: r.price, carbon: r.carbon, latency: r.latency,
      status: excluded ? 'excluded' : 'candidate', excluded_reason: excluded,
    }
  })
  const candidates = considered.filter((c) => c.status === 'candidate')

  const trace: TraceStep[] = [{ tool: 'policy', label: `Applied policy — ${candidates.length}/${scored.length} regions pass` }]
  for (const c of considered.filter((c) => c.status === 'excluded')) {
    trace.push({ tool: 'policy', label: `Excluded ${c.region} (${c.excluded_reason})` })
  }

  // worst region across ALL regions (naive-baseline for savings)
  const worst = [...scored].sort((a, b) => b.composite_score - a.composite_score)[0]

  // ── empty-candidate guard: don't call the model on an impossible request
  if (!candidates.length) {
    res.status(200).json({
      ok: false,
      reason: 'No region satisfies the policy constraints.',
      considered, trace,
      audit: { model: MODEL, effort: EFFORT, iterations: 0, weights, user_location: userLoc, generated_at: new Date(nowMs).toISOString() },
    })
    return
  }

  const candidateNames = candidates.map((c) => c.region)

  // Pre-compute everything the agent needs so it can decide in ONE call.
  const conditions = candidates.map((c) => {
    const sr = scored.find((s) => s.name === c.region)!
    const pts = fcFor(c.region)?.forecast ?? []
    let cleanest: { in_hours: number; carbon: number } | null = null
    if (pts.length) {
      let bi = 0
      for (let i = 1; i < pts.length; i++) if (pts[i].carbon < pts[bi].carbon) bi = i
      cleanest = { in_hours: bi + 1, carbon: pts[bi].carbon }
    }
    const e = estimateCost(sr, mw, hours)
    return {
      region: c.region, price_usd_mwh: c.price, carbon_gco2_kwh: c.carbon,
      renewable_pct: sr.renewable_pct, fossil_free_pct: sr.fossil_free_pct, top_source: sr.top_source,
      ambient_temp_f: sr.temp_f, base_pue: sr.base_pue, pue: sr.pue, // pue is temperature-adjusted
      latency_ms: c.latency, composite_score: c.score,
      projected_cost_usd: round(e.cost), projected_co2_tonnes: round(e.co2_tonnes, 2),
      cleanest_upcoming: cleanest,
    }
  })

  // the server did the gather work — reflect it in the trace for the UI
  trace.push({ tool: 'get_live_conditions', label: `Analyzed live conditions — ${candidates.length} candidate region(s)` })
  trace.push({ tool: 'get_carbon_forecast', label: 'Reviewed 24h carbon forecast' })
  trace.push({ tool: 'estimate_cost', label: `Computed projected cost (${mw} MW × ${hours} h)` })

  const submitTool: Anthropic.Tool = {
    name: 'submit_decision',
    description: 'Submit the final routing decision for the workload.',
    input_schema: {
      type: 'object',
      properties: {
        region: { type: 'string', enum: candidateNames, description: 'Region to route to (one of the candidates)' },
        run_now: { type: 'boolean', description: 'true to run now, false to defer' },
        defer_hours: { type: 'integer', description: 'Hours to defer (0 if running now)' },
        rationale: { type: 'string', description: 'Concise executive justification citing the numbers' },
      },
      required: ['region', 'run_now', 'defer_hours', 'rationale'],
      additionalProperties: false,
    },
  }

  const system = [
    'You are the routing agent for a compute-workload placement system. You are given the live conditions, 24h carbon forecast summary, and projected cost for every candidate region — all the data you need is in the message.',
    'REGION SELECTION: composite_score is the priority-weighted ranking and is AUTHORITATIVE — choose the region with the LOWEST composite_score. It already reflects this workload\'s exact weights across cost, efficiency (PUE), carbon, and latency. So for a latency-first (inference) workload, a distant low-carbon region will correctly have a WORSE (higher) composite_score — do NOT override the ranking to chase a greener region. Pick the lowest composite_score, period.',
    'TIMING (separate from region): latency and PUE are geographic and do not change over time; deferring only changes WHEN the job runs and the carbon at that hour. Deferral never improves latency and never changes which region is best. After selecting the lowest-composite region, decide its timing: for a FLEXIBLE workload, defer that region to a cleaner upcoming hour only if the carbon drop is meaningful (most impactful when carbon is heavily weighted); for an INFLEXIBLE one, run now (defer_hours 0).',
    'PUE is already temperature-adjusted (base_pue = nameplate, pue = temperature-adjusted value used in the score). renewable_pct / fossil_free_pct / top_source describe each region\'s live generation mix — you may cite them in the rationale, but they do not override the composite_score for region selection.',
    'Every candidate already satisfies all hard policy constraints — choose among them.',
    'Call submit_decision. Rationale: measured, professional, specific with the numbers (name the composite_score you chose on). No emojis, no exclamation points.',
  ].join('\n')

  const userMsg = [
    `Workload: ${body.workload.name ?? 'unnamed'} — ${mw} MW for ${hours} h, ${flexible ? 'FLEXIBLE (may defer up to 24h)' : 'INFLEXIBLE (run now)'}.`,
    `Priorities (weights 0-1): cost ${weights.alpha}, efficiency ${weights.beta}, carbon ${weights.gamma}, latency ${weights.delta}.`,
    `Users located in: ${userLoc}.`,
    `Candidates: ${JSON.stringify(conditions)}`,
  ].join('\n')

  const client = new Anthropic()
  let decision: Decision | null = null
  const iterations = 1

  // ONE forced call — model decides directly from the pre-loaded data
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: EFFORT },
      system,
      tools: [submitTool],
      tool_choice: { type: 'tool', name: 'submit_decision' },
      messages: [{ role: 'user', content: userMsg }],
    })
    const submit = resp.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_decision'
    )
    if (submit) decision = submit.input as Decision
  } catch (err) {
    console.error('[/api/decide] model error', err)
  }

  // ── fallback: model never submitted → deterministic top candidate ────
  if (!decision || !candidateNames.includes(decision.region)) {
    decision = { region: candidates[0].region, run_now: true, defer_hours: 0, rationale: 'Auto-selected the top-ranked candidate (agent did not return a valid decision).' }
    trace.push({ tool: 'fallback', label: 'Agent did not submit — defaulted to top candidate' })
  }

  // ── guardrails the model cannot override ─────────────────────────────
  if (!flexible) { decision.run_now = true; decision.defer_hours = 0 }
  const deferHours = decision.run_now ? 0 : Math.max(0, Math.min(24, Math.round(decision.defer_hours || 0)))
  const runNow = deferHours === 0
  const deferUntil = runNow ? null : new Date(nowMs + deferHours * 3_600_000).toISOString()

  // ── deterministic recompute (Claude judges; code does the arithmetic) ─
  const chosen = scored.find((s) => s.name === decision!.region)!
  const chosenCarbon = runNow ? chosen.carbon : carbonAt(fcFor(chosen.name), deferHours, chosen.carbon)
  const chosenEcon = estimateCost({ ...chosen, carbon: chosenCarbon }, mw, hours)
  const worstEcon = estimateCost(worst, mw, hours)

  trace.push({ tool: 'submit_decision', label: `Decision: ${chosen.name}${runNow ? ' — run now' : ` — defer ${deferHours}h`}` })

  res.status(200).json({
    ok: true,
    recommendation: { region: chosen.name, run_now: runNow, defer_hours: deferHours, defer_until: deferUntil },
    projected: {
      energy_cost_usd: round(chosenEcon.cost),
      co2_tonnes: round(chosenEcon.co2_tonnes, 2),
      savings_vs_worst_usd: round(worstEcon.cost - chosenEcon.cost),
      savings_vs_worst_co2_tonnes: round(worstEcon.co2_tonnes - chosenEcon.co2_tonnes, 2),
      baseline_region: worst.name,
    },
    rationale: decision.rationale,
    considered: considered.map((c) => (c.region === chosen.name ? { ...c, status: 'chosen' as const } : c)),
    trace,
    audit: { model: MODEL, effort: EFFORT, iterations, weights, user_location: userLoc, generated_at: new Date(nowMs).toISOString() },
  })
}
