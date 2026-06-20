import type { NextApiRequest, NextApiResponse } from 'next'

type CloudRegion = {
  name: string
  price: number
  pue: number
  carbon: number
  composite_score: number
}

type AnalyzeBody = {
  recommendation: string
  top3: CloudRegion[]
  scores: object
}

type AnalyzeResponse = {
  report: string
}

type ErrorResult = {
  error: string
}

const SYSTEM_PROMPT = [
  'You are the Head of Data Center Infrastructure at a major cloud provider, writing a briefing to senior leadership (your boss) recommending where to route a large compute workload.',
  'You are given real-time inputs per candidate region: electricity price ($/MWh), facility PUE, grid carbon intensity (gCO2/kWh), and a computed composite score where lower is better.',
  '',
  'Write a concise, professional executive briefing. Strict requirements:',
  '- Tone: measured, authoritative, data-driven — as a senior executive reporting to leadership.',
  '- Absolutely no emojis, no exclamation points, no decorative symbols, no casual or hyped language.',
  '- Lead with the recommendation and the bottom-line rationale in one or two sentences.',
  '- Justify with specific figures and the key tradeoffs across cost, carbon, and efficiency.',
  '- Note material risks or caveats (e.g., real-time price volatility, negative pricing, carbon variance).',
  '- Use clean markdown: brief section headings (plain text, no emoji) and a compact comparison table.',
  '- Be decisive and economical with words.',
].join('\n')

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<AnalyzeResponse | ErrorResult>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { recommendation, top3, scores } = req.body as AnalyzeBody

  if (!recommendation || !Array.isArray(top3)) {
    res.status(400).json({ error: 'recommendation and top3 are required' })
    return
  }

  let anthropicRes: Response
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':    'application/json',
        'x-api-key':       process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 800,
        system:     SYSTEM_PROMPT,
        messages: [
          {
            role:    'user',
            content: JSON.stringify({ recommendation, top3, scores }),
          },
        ],
      }),
    })
  } catch (err) {
    console.error('[/api/analyze] fetch error', err)
    res.status(502).json({ error: 'Failed to reach Anthropic API' })
    return
  }

  if (!anthropicRes.ok) {
    const body = await anthropicRes.text().catch(() => '')
    console.error(`[/api/analyze] Anthropic ${anthropicRes.status}`, body)
    res.status(502).json({ error: `Anthropic API error ${anthropicRes.status}` })
    return
  }

  const data = await anthropicRes.json()
  const report: string = data?.content?.[0]?.text ?? ''

  if (!report) {
    res.status(502).json({ error: 'Empty response from Anthropic API' })
    return
  }

  res.status(200).json({ report })
}
