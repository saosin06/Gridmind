// Single source of truth for region metadata. Previously duplicated across
// aggregate/carbon/pricing/forecast routes and Dashboard.tsx.

export type RegionMeta = {
  name: string
  pue: number              // facility Power Usage Effectiveness (static)
  lat: number
  lon: number
  carbonZone: string       // Electricity Maps zone code
  carbonFallback: number   // gCO2/kWh when live carbon unavailable
  pricingKey: string       // label used in pricing results ('CAISO'|'PJM'|'ERCOT')
  pricingDataset: string   // GridStatus dataset id
  pricingLocation: string  // representative load-side node
  pricingField: 'lmp' | 'spp'
  pricingFallback: number  // $/MWh when live price unavailable
  cloudRegion: string      // representative cloud region for generated IaC
  flyRegion: string        // Fly.io region code for real deploys
  renewableFallback: number   // % renewable when live power-mix unavailable
  fossilFreeFallback: number  // % fossil-free fallback
  topSourceFallback: string   // dominant generation source fallback
}

export const REGIONS: RegionMeta[] = [
  {
    name: 'San Jose', pue: 1.55, lat: 37.3382, lon: -121.8863,
    carbonZone: 'US-CAL-CISO', carbonFallback: 200,
    pricingKey: 'CAISO', pricingDataset: 'caiso_lmp_real_time_5_min',
    pricingLocation: 'DLAP_PGAE-APND', pricingField: 'lmp', pricingFallback: 45.50,
    cloudRegion: 'us-west-1', flyRegion: 'sjc',
    renewableFallback: 60, fossilFreeFallback: 80, topSourceFallback: 'wind',
  },
  {
    name: 'Ashburn', pue: 1.67, lat: 38.9940, lon: -77.4897,
    carbonZone: 'US-MIDA-PJM', carbonFallback: 350,
    pricingKey: 'PJM', pricingDataset: 'pjm_lmp_real_time_5_min',
    pricingLocation: 'DOM', pricingField: 'lmp', pricingFallback: 52.30,
    cloudRegion: 'us-east-1', flyRegion: 'iad',
    renewableFallback: 4, fossilFreeFallback: 40, topSourceFallback: 'gas',
  },
  {
    name: 'Austin', pue: 1.62, lat: 30.2672, lon: -97.7431,
    carbonZone: 'US-TEX-ERCO', carbonFallback: 390,
    pricingKey: 'ERCOT', pricingDataset: 'ercot_spp_real_time_15_min',
    pricingLocation: 'LZ_AEN', pricingField: 'spp', pricingFallback: 38.20,
    cloudRegion: 'us-south-1', flyRegion: 'dfw',
    renewableFallback: 40, fossilFreeFallback: 50, topSourceFallback: 'wind',
  },
]

// Where the workload's users are — for latency estimates.
export const USER_LOCATIONS = [
  { key: 'us-east',    label: 'US East (Virginia)',  lat: 38.95, lon: -77.45 },
  { key: 'us-west',    label: 'US West (Bay Area)',  lat: 37.77, lon: -122.42 },
  { key: 'us-central', label: 'US Central (Chicago)', lat: 41.88, lon: -87.63 },
  { key: 'eu',         label: 'Europe (London)',     lat: 51.51, lon: -0.13 },
  { key: 'apac',       label: 'APAC (Singapore)',    lat: 1.35,  lon: 103.82 },
]

export const regionByName = (name: string) => REGIONS.find((r) => r.name === name)
