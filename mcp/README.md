# GridMind MCP server

Exposes GridMind's carbon- and cost-aware compute routing as [MCP](https://modelcontextprotocol.io) tools, so any MCP client (Claude Code, Claude Desktop, or your own agent) can **observe the grid, route a workload, and act** — without a dashboard.

It's a thin client over the live GridMind API, so **no API keys are needed locally**.

## Tools

| Tool | What it does |
|---|---|
| `get_grid_conditions` | Live price, carbon, renewable %, generation mix, temperature-adjusted PUE, and temperature per region |
| `get_carbon_forecast` | Next-24h carbon forecast + cleanest upcoming hour per region |
| `route_workload` | Recommend the optimal region **and** timing for a workload, with projected cost/CO₂ and savings |
| `deploy_to_region` | **(real)** boot an actual Fly.io machine in a region to run the workload |
| `open_deployment_pr` | **(real)** open a GitHub PR with a Kubernetes manifest pinned to a region (GitOps) |

## Setup

```bash
cd mcp && npm install
```

### Claude Code
```bash
claude mcp add gridmind -- node /absolute/path/to/gridmind/mcp/server.mjs
```

### Claude Desktop — `claude_desktop_config.json`
```json
{
  "mcpServers": {
    "gridmind": {
      "command": "node",
      "args": ["/absolute/path/to/gridmind/mcp/server.mjs"]
    }
  }
}
```

Set `GRIDMIND_URL` to point at a different backend (defaults to the deployed instance, `https://gridmind-six.vercel.app`).

## Try it

Ask your agent:

> *"Use GridMind to find the best region to run a 50 MW training job for east-coast users, then open a deployment PR for it."*

It will call `get_grid_conditions` → `route_workload` → `open_deployment_pr`.

## Smoke test
```bash
npm test   # connects over stdio, lists tools, calls a couple
```
