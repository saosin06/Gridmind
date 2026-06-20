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
        <title>GridMind — Compute Workload Router</title>
        <meta name="description" content="Real-time multi-region compute routing by price, efficiency, and carbon intensity." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <ErrorBoundary>
        <Dashboard />
      </ErrorBoundary>
    </>
  )
}
