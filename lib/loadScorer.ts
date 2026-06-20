// Loads the Emscripten scorer (public/scorer.js) via a classic <script> tag.
// We deliberately avoid `import('/scorer.js')`: bundlers (Turbopack/webpack)
// try to resolve that path and mangle it, which breaks the load under dev HMR.
// A script tag is invisible to the bundler and works the same in dev and prod.

type GridMatcherInstance = {
  calculate_score(price: number, pue: number, carbon: number, alpha: number, beta: number, gamma: number): number
  benchmark_score(iterations: number, alpha: number, beta: number, gamma: number): number
  rank_regions(regions: VectorCloudRegion, alpha: number, beta: number, gamma: number): RankedVector
  predict_missing_price(historical: VectorFloat, temp: number): number
  delete(): void
}

type RankedVector = { size(): number; get(i: number): CloudRegionValue; delete(): void }
type VectorCloudRegion = { push_back(r: CloudRegionValue): void; delete(): void }
type VectorFloat = { push_back(n: number): void; delete(): void }

export type CloudRegionValue = {
  name: string
  price: number
  pue: number
  carbon: number
  composite_score: number
}

export type ScorerModule = {
  GridMatcher: new () => GridMatcherInstance
  VectorCloudRegion: new () => VectorCloudRegion
  VectorFloat: new () => VectorFloat
}

declare global {
  interface Window {
    createGridMindScorer?: () => Promise<ScorerModule>
  }
}

let modulePromise: Promise<ScorerModule> | null = null

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('loadScorer called during SSR (no document)'))
      return
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-scorer="1"]')
    if (existing) {
      if (existing.dataset.loaded === '1') resolve()
      else {
        existing.addEventListener('load', () => resolve())
        existing.addEventListener('error', () => reject(new Error('failed to load /scorer.js')))
      }
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.dataset.scorer = '1'
    s.addEventListener('load', () => {
      s.dataset.loaded = '1'
      resolve()
    })
    s.addEventListener('error', () => reject(new Error('failed to load /scorer.js (network/404)')))
    document.head.appendChild(s)
  })
}

/** Loads + initializes the WASM scorer once; subsequent calls return the cache. */
export function loadScorer(): Promise<ScorerModule> {
  if (modulePromise) return modulePromise
  modulePromise = (async () => {
    await injectScript('/scorer.js')
    const factory = window.createGridMindScorer
    if (typeof factory !== 'function') {
      throw new Error('createGridMindScorer global missing after /scorer.js loaded')
    }
    return factory()
  })().catch((err) => {
    modulePromise = null // allow retry on next call
    throw err
  })
  return modulePromise
}
