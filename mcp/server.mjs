#!/usr/bin/env node
// GridMind MCP server — exposes carbon/cost-aware compute routing as tools any
// MCP client (Claude Code, Claude Desktop, etc.) can call. It's a thin client
// over the live GridMind API, so no API keys are needed locally.
//
// Config (GRIDMIND_URL env, defaults to the deployed instance).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = process.env.GRIDMIND_URL || 'https://gridmind-six.vercel.app'
const PROFILE = z.enum(['training', 'inference', 'batch', 'balanced'])
const REGION = z.enum(['San Jose', 'Ashburn', 'Austin'])
const USER_LOC = z.enum(['us-east', 'us-west', 'us-central', 'eu', 'apac'])

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, init)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error || `${path} -> HTTP ${res.status}`)
  return json
}
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })
const fail = (msg) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true })

const server = new McpServer({ name: 'gridmind', version: '1.0.0' })

// ── Observe ───────────────────────────────────────────────────────────
server.registerTool(
  'get_grid_conditions',
  {
    title: 'Get live grid conditions',
    description:
      'Live conditions for each data-center region (San Jose/CAISO, Ashburn/PJM, Austin/ERCOT): wholesale electricity price ($/MWh), grid carbon intensity (gCO2/kWh), renewable share (%), dominant generation source, temperature-adjusted PUE, and ambient temperature. Call this first to see the current state of the grid.',
  },
  async () => {
    try { return ok(await api('/api/aggregate')) } catch (e) { return fail(e.message) }
  }
)

server.registerTool(
  'get_carbon_forecast',
  {
    title: 'Get 24h carbon forecast',
    description:
      'Next-24-hour grid carbon-intensity forecast per region, with the cleanest upcoming hour. Use this to decide whether a flexible workload should be deferred to a lower-carbon window.',
  },
  async () => {
    try {
      const fc = await api('/api/forecast')
      const summary = (fc || []).map((r) => {
        const pts = r.forecast || []
        const cleanest = pts.length ? pts.reduce((a, b) => (b.carbon < a.carbon ? b : a)) : null
        return {
          region: r.region,
          current_carbon: pts[0]?.carbon ?? null,
          cleanest_carbon: cleanest?.carbon ?? null,
          points: pts.length,
        }
      })
      return ok(summary)
    } catch (e) { return fail(e.message) }
  }
)

// ── Decide ────────────────────────────────────────────────────────────
server.registerTool(
  'route_workload',
  {
    title: 'Route a compute workload',
    description:
      'Recommend the optimal region AND timing (run now or defer) for a single workload, given a priority profile and where the users are. Returns the chosen region, whether to defer (and by how many hours), the projected energy cost and CO2, and the savings versus the worst region. Deterministic and fast.',
    inputSchema: {
      mw: z.number().positive().describe('Power draw in megawatts'),
      hours: z.number().positive().describe('Duration in hours'),
      profile: PROFILE.default('balanced').describe('training = carbon-first, inference = latency-first, batch = cost-first, balanced = even'),
      flexible: z.boolean().default(true).describe('Whether the job may be deferred to a cleaner window'),
      user_location: USER_LOC.default('us-east').describe('Where the workload\'s users are (affects latency)'),
      max_carbon: z.number().optional().describe('Optional policy cap on grid carbon intensity (gCO2/kWh)'),
    },
  },
  async ({ mw, hours, profile, flexible, user_location, max_carbon }) => {
    try {
      const policy = max_carbon != null ? { max_carbon } : {}
      const { plans } = await api('/api/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobs: [{ id: 'workload', mw, hours, flexible, profile }], policy, user_location }),
      })
      return ok(plans?.[0] ?? { error: 'no plan returned' })
    } catch (e) { return fail(e.message) }
  }
)

// ── Act (real side effects) ───────────────────────────────────────────
server.registerTool(
  'deploy_to_region',
  {
    title: 'Deploy a workload to a region (real)',
    description:
      'REAL SIDE EFFECT: provisions an actual short-lived compute machine on Fly.io in the given region to run the workload (it auto-destroys after a few minutes). Use after route_workload to act on the decision.',
    inputSchema: {
      region: REGION.describe('Region to deploy to'),
      workload_name: z.string().describe('Name/label for the workload'),
    },
  },
  async ({ region, workload_name }) => {
    try {
      return ok(await api('/api/deploy-fly', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ region, workload: { name: workload_name } }),
      }))
    } catch (e) { return fail(e.message) }
  }
)

server.registerTool(
  'open_deployment_pr',
  {
    title: 'Open a deployment pull request (real)',
    description:
      'REAL SIDE EFFECT: opens an actual GitHub pull request containing a Kubernetes manifest that pins the workload to the given region (GitOps). Computes the projected cost/CO2 for the PR by routing the workload first.',
    inputSchema: {
      region: REGION,
      workload_name: z.string(),
      mw: z.number().positive(),
      hours: z.number().positive(),
      profile: PROFILE.default('balanced'),
    },
  },
  async ({ region, workload_name, mw, hours, profile }) => {
    try {
      const { plans } = await api('/api/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobs: [{ id: 'workload', mw, hours, flexible: false, profile }] }),
      })
      const p = plans?.[0] || {}
      const spec = {
        workload: { name: workload_name, mw, hours, profile },
        region, run_now: true, defer_until: null,
        projected: {
          energy_cost_usd: p.cost ?? 0,
          co2_tonnes: p.co2_tonnes ?? 0,
          savings_vs_worst_usd: p.savings_usd ?? 0,
          savings_vs_worst_co2_tonnes: p.savings_co2 ?? 0,
          baseline_region: p.baseline_region ?? 'n/a',
        },
        rationale: `Routed to ${region} for a ${profile} workload via GridMind (${p.reason ?? 'optimal placement'}).`,
      }
      return ok(await api('/api/deploy-pr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(spec),
      }))
    } catch (e) { return fail(e.message) }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[gridmind-mcp] ready — backend ${BASE}`)
