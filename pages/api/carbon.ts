import type { NextApiRequest, NextApiResponse } from 'next'

type CarbonResult = {
  zone: string
  carbon_intensity: number
}

type ErrorResult = {
  error: string
}

const ZONES = [
  { zone: 'US-CAL-CISO',  fallback: 200 },
  { zone: 'US-MIDA-PJM',  fallback: 350 },
  { zone: 'US-TEX-ERCO',  fallback: 390 }, // ERCOT — Electricity Maps zone code
]

async function fetchZoneIntensity(zone: string): Promise<number> {
  const url = new URL('https://api-access.electricitymaps.com/free-tier/carbon-intensity/latest')
  url.searchParams.set('zone', zone)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)

  try {
    // Electricity Maps expects the token as a header, not a query param
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'auth-token': process.env.ELECTRICITY_MAPS_AUTH_TOKEN ?? '' },
    })
    if (!res.ok) throw new Error(`Electricity Maps ${res.status}`)
    const data = await res.json()
    const intensity = data?.carbonIntensity
    if (typeof intensity !== 'number' || !Number.isFinite(intensity)) {
      throw new Error('Missing carbonIntensity in response')
    }
    return intensity
  } finally {
    clearTimeout(timer)
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CarbonResult[] | ErrorResult>
) {
  const results = await Promise.all(
    ZONES.map(async ({ zone, fallback }) => {
      try {
        const carbon_intensity = await fetchZoneIntensity(zone)
        return { zone, carbon_intensity }
      } catch (err) {
        console.error(`[/api/carbon] zone=${zone}`, err)
        return { zone, carbon_intensity: fallback }
      }
    })
  )

  res.status(200).json(results)
}
