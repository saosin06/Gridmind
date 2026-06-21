import { Component, ReactNode } from 'react'
import Head from 'next/head'
import Dashboard from '../components/Dashboard'

// Error boundary (class component — required for componentDidCatch)
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
        <div className="grid min-h-screen place-items-center bg-[#070b12] p-6 text-slate-100">
          <div className="max-w-md text-center">
            <h1 className="mb-2 text-xl font-semibold text-rose-400">Dashboard crashed</h1>
            <p className="mb-4 text-sm text-slate-400">{this.state.error.message}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="rounded-md bg-slate-800 px-4 py-2 text-sm transition hover:bg-slate-700"
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

export default function Home() {
  return (
    <>
      <Head>
        <title>GridMind — Carbon & Cost-Aware Compute Routing</title>
        <meta name="description" content="GridMind routes compute workloads to the cheapest, cleanest region and time using live grid data — and an AI agent that decides and takes real action, within hard guardrails." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="GridMind — Carbon & Cost-Aware Compute Routing" />
        <meta property="og:description" content="Live grid data → an AI agent that routes compute to the cheapest, cleanest region and time, within guardrails — and takes real action." />
        <meta property="og:url" content="https://gridmind-six.vercel.app" />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="GridMind — Carbon & Cost-Aware Compute Routing" />
        <meta name="twitter:description" content="An AI agent that routes compute to the cheapest, cleanest region and time — and takes real action." />
      </Head>
      <ErrorBoundary>
        <Dashboard />
      </ErrorBoundary>
    </>
  )
}
