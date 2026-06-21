// Smoke test: connect to the server over stdio, list tools, call a couple.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({ command: 'node', args: ['server.mjs'] })
const client = new Client({ name: 'gridmind-test', version: '1.0.0' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log('TOOLS:', tools.map((t) => t.name).join(', '))

const cond = await client.callTool({ name: 'get_grid_conditions', arguments: {} })
console.log('\nget_grid_conditions ->\n', cond.content[0].text.slice(0, 300))

const route = await client.callTool({
  name: 'route_workload',
  arguments: { mw: 20, hours: 6, profile: 'inference', flexible: true, user_location: 'us-east' },
})
console.log('\nroute_workload (inference, us-east) ->\n', route.content[0].text)

await client.close()
console.log('\nOK')
