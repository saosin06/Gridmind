import type { NextApiRequest, NextApiResponse } from 'next'
import { getRegions, getForecast } from '../../lib/gridmind/data'
import { planJobs, type JobInput, type JobPlan, type Policy } from '../../lib/gridmind/scheduler'

// Deterministic batch router for the fleet scheduler's hot loop — fast, no LLM.
export const config = { maxDuration: 15 }

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ plans: JobPlan[]; snapshot_at: string } | { error: string }>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { jobs, policy, user_location } = req.body as {
    jobs: JobInput[]
    policy?: Policy
    user_location?: string
  }

  if (!Array.isArray(jobs) || !jobs.length) {
    res.status(400).json({ error: 'jobs must be a non-empty array' })
    return
  }

  const [regions, forecasts] = await Promise.all([getRegions(), getForecast()])
  const plans = planJobs(jobs, regions, forecasts, policy ?? {}, user_location ?? 'us-east', Date.now())

  res.status(200).json({ plans, snapshot_at: new Date().toISOString() })
}
