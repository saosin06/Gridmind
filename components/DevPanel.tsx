'use client'

import { useState, useEffect } from 'react'

const API_CURL = `curl -s -X POST https://gridmind-six.vercel.app/api/schedule \\
  -H 'content-type: application/json' \\
  -d '{"jobs":[{"id":"job1","mw":50,"hours":12,
        "flexible":true,"profile":"training"}]}'`

const MCP_SETUP = `git clone https://github.com/saosin06/Gridmind.git
cd Gridmind/mcp && npm install
claude mcp add gridmind -- node "$(pwd)/server.mjs"`

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-[#0a111c] p-3 pr-14 text-[12px] leading-relaxed text-slate-300"><code>{code}</code></pre>
      <button
        onClick={() => { navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
        className="absolute right-2 top-2 rounded bg-slate-800 px-2 py-1 text-[10px] text-slate-400 transition hover:text-emerald-300"
      >{copied ? 'copied ✓' : 'copy'}</button>
    </div>
  )
}

export default function DevPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="gm-card gm-fade-up max-h-[85vh] w-full max-w-2xl overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Developers</h2>
            <p className="mt-0.5 text-xs text-slate-400">GridMind is API-first — call it from your pipeline, or let an AI agent call it as a tool.</p>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200">✕</button>
        </div>

        {/* REST API */}
        <section className="mb-6">
          <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-emerald-300">REST API</h3>
          <p className="mb-2 text-xs text-slate-400">
            <code className="text-slate-300">POST /api/schedule</code> routes a batch of jobs (fast, deterministic).
            <code className="ml-1 text-slate-300">POST /api/decide</code> runs the full Claude agent with a rationale. Both return the region, timing, projected cost/CO₂, and savings.
          </p>
          <CodeBlock code={API_CURL} />
        </section>

        {/* MCP */}
        <section className="mb-6">
          <h3 className="mb-1 text-sm font-semibold text-emerald-300">MCP server</h3>
          <p className="mb-2 text-xs text-slate-400">
            Expose GridMind as tools any agent (Claude Code, Claude Desktop, your own) can call — <span className="text-slate-300">observe → route → act</span>. No API keys needed locally.
          </p>
          <CodeBlock code={MCP_SETUP} />
          <p className="mt-2 text-xs text-slate-400">Then ask your agent:</p>
          <p className="mt-1 rounded-lg border border-slate-800 bg-[#0a111c] px-3 py-2 text-xs italic text-slate-300">“Use GridMind to find the best region for a 50 MW training job for east-coast users, then open a deployment PR.”</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {['get_grid_conditions', 'get_carbon_forecast', 'route_workload', 'deploy_to_region', 'open_deployment_pr'].map((t) => (
              <span key={t} className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400">{t}</span>
            ))}
          </div>
        </section>

        <div className="flex items-center justify-between border-t border-slate-800 pt-4 text-xs">
          <span className="text-slate-500">Same engine powers the dashboard, the API, and the MCP server.</span>
          <a href="https://github.com/saosin06/Gridmind" target="_blank" rel="noopener noreferrer" className="text-emerald-300 hover:underline">GitHub ↗</a>
        </div>
      </div>
    </div>
  )
}
