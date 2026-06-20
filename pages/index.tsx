import { Component, ReactNode, useState, useEffect } from 'react'
import Head from 'next/head'
import Dashboard from '../components/Dashboard'

// --- Error Boundary (class component — required for componentDidCatch) ---
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[Dashboard ErrorBoundary]', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-6 font-mono">
          <div className="max-w-md text-center">
            <h1 className="text-xl font-bold text-red-400 mb-2">Dashboard crashed</h1>
            <p className="text-sm text-gray-400 mb-4">{this.state.error.message}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm"
            >
              Retry
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

type WasmStatus = 'loading' | 'ready' | 'fallback'

export default function Home() {
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>('loading')

  // WASM init test — error boundaries don't catch async/effect errors, so this
  // must be try/catch'd here rather than thrown to the boundary.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // @ts-expect-error: Emscripten output in /public — not in TS module registry
        const factory = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ '/scorer.js')
        const m = await (factory.default ?? factory)()
        const matcher = new m.GridMatcher()
        matcher.calculate_score(45.5, 1.55, 234, 0.4, 0.3, 0.3) // smoke test
        matcher.delete()
        if (!cancelled) setWasmStatus('ready')
      } catch (err) {
        console.warn('[WASM] init failed — using JS fallback', err)
        if (!cancelled) setWasmStatus('fallback')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <Head>
        <title>GridMind — Compute Workload Router</title>
        <meta name="description" content="Real-time multi-region compute routing by price, efficiency, and carbon intensity." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main className="bg-gray-900 min-h-screen">
        {/* WASM engine status badge */}
        <div className="bg-gray-900 text-white px-6 pt-4 font-mono text-xs">
          <span className="text-gray-500">scoring engine:</span>{' '}
          {wasmStatus === 'loading' && <span className="text-yellow-400">initializing…</span>}
          {wasmStatus === 'ready'    && <span className="text-green-400">● WASM</span>}
          {wasmStatus === 'fallback' && <span className="text-blue-400">● JS fallback</span>}
        </div>

        <ErrorBoundary>
          <Dashboard />
        </ErrorBoundary>
      </main>
    </>
  )
}
