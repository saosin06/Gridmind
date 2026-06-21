import type { NextApiRequest, NextApiResponse } from 'next'
import Anthropic from '@anthropic-ai/sdk'

// Periodic operator briefing for the autonomous fleet. Uses Sonnet (fast/cheap)
// because this fires on a cadence — the deep reasoning model is reserved for the
// single-job decision agent (/api/decide).
export const config = { maxDuration: 20 }
const MODEL = 'claude-sonnet-4-6'

const SYSTEM = [
  'You are the operations lead for GridMind, an autonomous compute-workload routing fleet, giving a brief status update to engineering leadership.',
  'You are given the current simulated hour, cumulative savings, the queue breakdown, and the recent activity log.',
  'Summarize what the autopilot has done: jobs routed, deferred, and completed; cumulative cost and carbon savings; and any notable routing decisions.',
  'Two to four sentences. Specific with numbers. Measured and professional. No emojis, no exclamation points, no headings — just the briefing prose (one short paragraph, or at most two).',
].join('\n')

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ briefing: string } | { error: string }>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { sim_hour, totals, queue, recent_activity } = req.body ?? {}

  try {
    const client = new Anthropic()
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      output_config: { effort: 'low' },
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ sim_hour, totals, queue, recent_activity }) }],
    })
    const text = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? ''
    if (!text) {
      res.status(502).json({ error: 'Empty briefing' })
      return
    }
    res.status(200).json({ briefing: text })
  } catch (err) {
    console.error('[/api/briefing]', err)
    res.status(502).json({ error: 'Briefing unavailable' })
  }
}
