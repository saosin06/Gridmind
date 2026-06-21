# GridMind — 3-minute demo script

Live: **https://gridmind-six.vercel.app** · keep your **Fly.io dashboard** open in another tab (logged in).

> Tip: load the site once a minute before you present so the edge cache is warm (first cold load is slow; after that it's instant).

---

## 0:00 — The problem (15s, on the Overview tab)
> "Companies running large compute pick a cloud region once and run everything there. But electricity prices and grid carbon swing 3–5× by region and by hour — California is at **−$5/MWh and 50 gCO₂** right now while others are 5× dirtier. That's money and emissions wasted. GridMind fixes it."

Point at the **KPI strip** (Recommended · Cheapest · Cleanest · Arbitrage spread) and the **region matrix** — *"this is live grid data, updating right now."*

## 0:30 — The agent decides (45s, Routing Agent tab)
- Pick **Training** profile, set a workload (e.g. 50 MW × 12h), hit **⚡ Run routing agent**.
- As the trace animates, narrate: *"It analyzes live conditions, the 24-hour carbon forecast, and projected cost — then decides."*
- Read the decision card: *"It chose **San Jose** and is **deferring 14 hours** to a cleaner window — and here's the projected savings vs the worst region, with Claude's rationale citing the actual numbers."*

## 1:15 — The guardrail (30s)
> "This isn't a chatbot guessing — guardrails are enforced in code."
- Toggle a policy: uncheck **San Jose** (or set **max carbon** below it), re-run.
- *"The agent physically cannot pick an excluded region — and the cost/CO₂ numbers are recomputed deterministically. The model judges; the code does the math."*

## 1:45 — It takes real action (45s)
- Click **⚡ Deploy to Fly (real)** → *"✓ Machine live in `sjc`."*
- Switch to your **Fly.io dashboard** → show the real machine running **in San Jose** — the exact region the agent chose.
> "It didn't just recommend — it provisioned real compute in the optimal region. The other button opens a real GitHub PR with a Kubernetes manifest, which is how teams actually adopt this via GitOps."

## 2:30 — Autonomous at scale (20s, Fleet Autopilot tab)
- Hit **▶ Start autopilot**.
- *"At fleet scale it runs itself — continuously routing a queue of jobs, accumulating savings, and Claude writes the operator briefings. Routing is deterministic for scale; the LLM is reserved for decisions and the narrative."*
- Point at **cumulative savings** ticking up.

## 2:50 — Close (10s)
> "Live grid data, an agent that decides within hard guardrails, and real action — deployed and running. In production each company connects their own cloud; today it deploys to ours."

---

## If something's slow / fails on stage
- **Agent feels slow:** it's ~7s; the trace animation covers it.
- **Prices look static (45.5 / 52.3 / 38.2):** GridStatus quota — carbon is still live; say "representative prices, carbon is live."
- **Fly link asks you to log in:** that's the owner-only console — the on-screen "✓ Machine live in sjc" is the proof; show your own dashboard tab.
- **First load blank:** hard-refresh; it was a cold edge-cache miss.
