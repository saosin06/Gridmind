import type { NextApiRequest, NextApiResponse } from 'next'
import Anthropic from '@anthropic-ai/sdk'
import { getRegions, getForecast, type RegionForecast } from '../../lib/gridmind/data'
import {
  withLatency, rankRegions, scoreRegion, latencyFor,
  PRESETS, DEFAULT_WEIGHTS, type Weights,
} from '../../lib/gridmind/scoring'
import { estimateCost } from '../../lib/gridmind/economics'
import { REGIONS } from '../../lib/gridmind/regions'

// Opus tool loops are slow + this is non-streaming → give it headroom.
export const config = { maxDuration: 60 }

const MODEL = 'claude-opus-4-8'
const EFFORT = 'low'        // snappy; the snapshot is pre-fetched so only round-trips cost
const MAX_ITERS = 5

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

  // ── tool data sourced from the frozen snapshot ───────────────────────
  const liveConditions = () =>
    candidates.map((c) => ({ region: c.region, price_mwh: c.price, pue: REGIONS.find((r) => r.name === c.region)!.pue, carbon: c.carbon, latency_ms: c.latency, score: c.score }))
  const carbonForecast = () =>
    candidateNames.map((name) => {
      const fc = fcFor(name)
      const pts = (fc?.forecast ?? []).map((p, i) => ({ hours_ahead: i + 1, carbon: p.carbon }))
      const cleanest = pts.length ? pts.reduce((a, b) => (b.carbon < a.carbon ? b : a)) : null
      const cur = candidates.find((c) => c.region === name)!.carbon
      return { region: name, current_carbon: cur, cleanest, points: pts }
    })
  const costFor = (region: string) => {
    const r = scored.find((s) => s.name === region)!
    const e = estimateCost(r, mw, hours)
    return { region, energy_cost_usd: round(e.cost), co2_tonnes: round(e.co2_tonnes, 2) }
  }

  // ── tool definitions ─────────────────────────────────────────────────
  const tools: Anthropic.Tool[] = [
    { name: 'get_live_conditions', description: 'Current price, PUE, carbon, latency, and composite score for each candidate region. Call this first.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'get_carbon_forecast', description: 'Next-24h carbon-intensity forecast per candidate region, with the cleanest upcoming hour. Use to decide whether to run now or defer a flexible workload.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'estimate_cost', description: 'Energy cost ($) and emissions (tonnes CO2) of running this workload in a region.', input_schema: { type: 'object', properties: { region: { type: 'string', enum: candidateNames } }, required: ['region'], additionalProperties: false } },
    {
      name: 'submit_decision',
      description: 'Submit the final routing decision. Call this exactly once, alone, after gathering data.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          region: { type: 'string', enum: candidateNames, description: 'Region to route the workload to' },
          run_now: { type: 'boolean', description: 'true to run immediately, false to defer' },
          defer_hours: { type: 'integer', description: 'Hours to defer (0 if running now)' },
          rationale: { type: 'string', description: 'Concise executive justification citing the numbers' },
        },
        required: ['region', 'run_now', 'defer_hours', 'rationale'],
        additionalProperties: false,
      },
    },
  ]

  const system = [
    'You are the routing agent for a compute-workload placement system, briefing on where and when to run a large job.',
    'Gather the facts with the read tools first (live conditions, then carbon forecast and cost estimates as needed), then call submit_decision exactly once as your final step.',
    'Weigh the workload priorities across cost, efficiency (PUE), carbon, and latency. For flexible workloads, consider deferring to a cleaner upcoming hour if the carbon drop is meaningful; for inflexible ones, run now.',
    'The candidate regions have already been filtered to satisfy all hard policy constraints — every candidate is valid; choose among them.',
    'In the rationale: measured, professional, specific with numbers. No emojis, no exclamation points.',
  ].join('\n')

  const userMsg =
    `Workload: ${body.workload.name ?? 'unnamed'} — ${mw} MW for ${hours} h, ${flexible ? 'FLEXIBLE (may defer)' : 'INFLEXIBLE (run now)'}.` +
    `\nPriorities (weights): cost ${weights.alpha}, efficiency ${weights.beta}, carbon ${weights.gamma}, latency ${weights.delta}.` +
    `\nUsers located in: ${userLoc}.` +
    `\nCandidate regions: ${candidateNames.join(', ')}.`

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }]
  const client = new Anthropic()

  let decision: Decision | null = null
  let iterations = 0

  try {
    for (let i = 0; i < MAX_ITERS && !decision; i++) {
      iterations++
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT },
        system,
        tools,
        messages,
      })

      if (resp.stop_reason !== 'tool_use') break
      messages.push({ role: 'assistant', content: resp.content })

      const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      const submit = toolUses.find((t) => t.name === 'submit_decision')
      if (submit) {
        decision = submit.input as Decision
        break
      }

      const results: Anthropic.ToolResultBlockParam[] = []
      for (const t of toolUses) {
        let out: unknown
        if (t.name === 'get_live_conditions') { out = liveConditions(); trace.push({ tool: t.name, label: `Checked live grid conditions — ${candidates.length} regions` }) }
        else if (t.name === 'get_carbon_forecast') { out = carbonForecast(); trace.push({ tool: t.name, label: 'Pulled 24h carbon forecast' }) }
        else if (t.name === 'estimate_cost') { const region = (t.input as { region: string }).region; out = costFor(region); trace.push({ tool: t.name, label: `Estimated cost for ${region} (${mw}MW × ${hours}h)` }) }
        else out = { error: `unknown tool ${t.name}` }
        results.push({ type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(out) })
      }
      messages.push({ role: 'user', content: results })
    }
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
