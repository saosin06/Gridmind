import type { NextApiRequest, NextApiResponse } from 'next'
import { regionByName } from '../../lib/gridmind/regions'

// Real side effect: boots an actual Fly.io Machine in the region the agent chose.
// Short-lived placeholder job (~2 min) with auto_destroy → near-zero cost, no leftovers.
export const config = { maxDuration: 30 }

const FLY = 'https://api.machines.dev/v1'
const APP = process.env.FLY_APP ?? 'gridmind-jobs'
const ORG = process.env.FLY_ORG ?? 'personal'

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'job'

async function fly(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${FLY}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const json = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, json }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  const token = process.env.FLY_API_TOKEN
  if (!token) {
    res.status(400).json({ error: 'FLY_API_TOKEN not configured on the server' })
    return
  }

  const { region, workload } = req.body as { region: string; workload?: { name?: string } }
  const meta = regionByName(region)
  if (!meta) {
    res.status(400).json({ error: `unknown region ${region}` })
    return
  }
  const flyRegion = meta.flyRegion
  const name = `${slug(workload?.name ?? 'gridmind')}-${Date.now().toString(36)}`

  try {
    // 1. ensure the app exists (create on first use)
    const got = await fly(`/apps/${APP}`, token)
    if (got.status === 404) {
      const created = await fly('/apps', token, {
        method: 'POST',
        body: JSON.stringify({ app_name: APP, org_slug: ORG }),
      })
      if (!created.ok) {
        res.status(502).json({ error: `Fly app create failed (${created.status}): ${created.json?.error ?? 'set FLY_APP/FLY_ORG'}` })
        return
      }
    } else if (!got.ok) {
      res.status(502).json({ error: `Fly app check failed (${got.status}): ${got.json?.error ?? 'check FLY_API_TOKEN'}` })
      return
    }

    // 2. boot a real machine in the chosen region (self-destroying short job)
    const machine = await fly(`/apps/${APP}/machines`, token, {
      method: 'POST',
      body: JSON.stringify({
        name,
        region: flyRegion,
        config: {
          image: 'alpine:3.20',
          guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
          restart: { policy: 'no' },
          auto_destroy: true,
          env: { GRIDMIND_WORKLOAD: workload?.name ?? 'workload', GRIDMIND_REGION: region },
          init: { exec: ['/bin/sh', '-c', `echo "GridMind running ${workload?.name ?? 'workload'} in $FLY_REGION"; sleep 120`] },
        },
      }),
    })
    if (!machine.ok) {
      res.status(502).json({ error: `Fly machine create failed (${machine.status}): ${machine.json?.error ?? 'unknown'}` })
      return
    }

    res.status(200).json({
      machine_id: machine.json.id,
      region: flyRegion,
      state: machine.json.state,
      app: APP,
      dashboard: `https://fly.io/apps/${APP}/machines/${machine.json.id}`,
    })
  } catch (err) {
    console.error('[/api/deploy-fly]', err)
    res.status(502).json({ error: err instanceof Error ? err.message : 'Fly deploy failed' })
  }
}
