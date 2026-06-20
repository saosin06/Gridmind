import type { NextApiRequest, NextApiResponse } from 'next'

type CloudRegion = {
  name: string
  price: number
  pue: number
  carbon: number
  composite_score: number
}

type ErrorResult = {
  error: string
}

// Static PUE per region (Power Usage Effectiveness — facility-level, not API-sourced)
const REGION_META = [
  {
    name:         'San Jose',
    pue:          1.55,
    weatherKey:   'San Jose',
    carbonKey:    'US-CAL-CISO',
    pricingKey:   'CAISO',
    fallbackPrice:   45.50,
    fallbackCarbon: 200,
  },
  {
    name:         'Ashburn',
    pue:          1.67,
    weatherKey:   'Ashburn',
    carbonKey:    'US-MIDA-PJM',
    pricingKey:   'PJM',
    fallbackPrice:   52.30,
    fallbackCarbon: 350,
  },
  {
    name:         'Austin',
    pue:          1.62,
    weatherKey:   'Austin',
    carbonKey:    'US-TEX-ERCO',
    pricingKey:   'ERCOT',
    fallbackPrice:   38.20,
    fallbackCarbon: 390,
  },
]

function baseUrl(req: NextApiRequest): string {
  const proto = req.headers['x-forwarded-proto'] ?? 'http'
  const host  = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:3000'
  return `${proto}://${host}`
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CloudRegion[] | ErrorResult>
) {
  const base = baseUrl(req)

  const [weatherSettled, carbonSettled, pricingSettled] = await Promise.allSettled([
    fetch(`${base}/api/weather`).then((r) => r.json()),
    fetch(`${base}/api/carbon`).then((r)  => r.json()),
    fetch(`${base}/api/pricing`).then((r) => r.json()),
  ])

  const weather: { region: string; temp_f: number; humidity: number; dew_point: number }[] =
    weatherSettled.status === 'fulfilled' ? weatherSettled.value : []

  const carbon: { zone: string; carbon_intensity: number }[] =
    carbonSettled.status === 'fulfilled' ? carbonSettled.value : []

  const pricing: { region: string; price_mwh: number }[] =
    pricingSettled.status === 'fulfilled' ? pricingSettled.value : []

  if (weatherSettled.status === 'rejected') console.error('[/api/aggregate] weather', weatherSettled.reason)
  if (carbonSettled.status  === 'rejected') console.error('[/api/aggregate] carbon',  carbonSettled.reason)
  if (pricingSettled.status === 'rejected') console.error('[/api/aggregate] pricing', pricingSettled.reason)

  const regions: CloudRegion[] = REGION_META.map(({ name, pue, weatherKey, carbonKey, pricingKey, fallbackPrice, fallbackCarbon }) => {
    const carbonRow  = carbon.find((c) => c.zone === carbonKey)
    const pricingRow = pricing.find((p) => p.region === pricingKey)

    return {
      name,
      price:           pricingRow?.price_mwh       ?? fallbackPrice,
      pue,
      carbon:          carbonRow?.carbon_intensity  ?? fallbackCarbon,
      composite_score: 0,
    }
  })

  res.status(200).json(regions)
}
