// Smoke test / demo: connect over stdio, list tools, pull live conditions,
// then route the SAME workload under different priorities to show the decision
// actually changes (not hardcoded).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({ command: 'node', args: ['server.mjs'] })
const client = new Client({ name: 'gridmind-test', version: '1.0.0' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log('TOOLS:', tools.map((t) => t.name).join(', '))

const cond = await client.callTool({ name: 'get_grid_conditions', arguments: {} })
console.log('\nget_grid_conditions (live) ->')
for (const r of JSON.parse(cond.content[0].text)) {
  console.log(`  ${r.name.padEnd(9)} $${r.price}/MWh  ${r.carbon} gCO2  ${r.renewable_pct}% renewable (${r.top_source})`)
}

// Same 50 MW x 12 h workload, different priorities/locations — region should change.
const scenarios = [
  { label: 'training  · us-east (carbon-first)', profile: 'training', user_location: 'us-east' },
  { label: 'inference · us-east (latency-first)', profile: 'inference', user_location: 'us-east' },
  { label: 'inference · us-west (latency-first)', profile: 'inference', user_location: 'us-west' },
  { label: 'training  · apac   (carbon-first)', profile: 'training', user_location: 'apac' },
]
console.log('\nroute_workload — same 50 MW × 12 h job, different priorities:')
for (const s of scenarios) {
  const r = await client.callTool({
    name: 'route_workload',
    arguments: { mw: 50, hours: 12, profile: s.profile, flexible: true, user_location: s.user_location },
  })
  const p = JSON.parse(r.content[0].text)
  console.log(`  ${s.label.padEnd(40)} -> ${String(p.region).padEnd(9)} (${p.reason})`)
}

await client.close()
console.log('\nOK')
