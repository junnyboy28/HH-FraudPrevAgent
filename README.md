# HH-FraudPrevAgent

An agentic fraud investigation system built for the TigerGraph "Agentic Fraud
Investigation HHGOA" hackathon. Given a fraud signal (a risk score, a customer
report, or an analyst request), the agent investigates the way a human fraud
analyst would: it pulls evidence from a TigerGraph knowledge graph, grounds its
reasoning in retrieved policy and pattern text (GraphRAG) plus similar prior
cases, assesses whether it has enough evidence and goes back for more when it
does not, then recommends or takes a next-best action through an explicit
permission gate and explains every step by citing the evidence that drove it.
The architecture is described in `docs/architecture.md`, the agent's behaviour
in `agent.md`, and the build sequence in `build_plan.md`.

## Status

The TigerGraph schema and the data load are built. Everything under `src/`,
`benchmarks/` and `ui/` is still a placeholder; no agent logic is implemented
yet.

## Layout

```
graph/       TigerGraph schema, load jobs, GSQL queries (one file per query)
src/         backend: orchestrator, tools, LLM layer, memory, API
ui/          Next.js case-view frontend (separate npm project)
data/        the HHGOA_IEEE dataset (gitignored, not checked in)
cases/       the 20 answer files, <case_id>.json: the graded deliverable
benchmarks/  the runner that produces cases/, plus its validator
config/      permissions.json (14 actions, 3 routes), policy_rules.json (R1-R10)
```

## Setup

Requires Node.js 20.11 or newer (developed on 22).

```
npm install                 # backend, graph tooling, benchmark runner
npm install --prefix ui     # Next.js frontend, separate dependency tree
```

### Environment

```
cp .env.example .env
```

Then fill in real values. `.env.example` is the authoritative list of variables:
TigerGraph connection details (`TIGERGRAPH_HOST`, `TIGERGRAPH_GRAPH_NAME`,
`TIGERGRAPH_TOKEN`) and the Claude API key (`ANTHROPIC_API_KEY`). There is no
second database: TigerGraph holds the graph, the vector store and case memory.
Never commit real values, and add any new variable to `.env.example` in the same
commit that introduces it.

The dataset is not checked in. Place it at `data/HHGOA_IEEE/` and read its
README before touching the fraud pattern queries, since that file, not the
hackathon brief, defines the five patterns.

### Graph

```
npm run prep:sample     # first 1,000 transactions into load-ready CSVs, ~13s
npm run prep:full       # all 590,742 transactions, ~45s

gsql graph/schema.gsql                      # install the schema
gsql -g FraudGraph graph/load/load_jobs.gsql   # install the loading job
gsql -g FraudGraph graph/load/run_full.gsql    # load
```

`graph/load/README.md` covers running this against Savanna or Community
Edition, the counts a good load produces, and how `card_id` is derived (the
dataset references cards the transaction file does not contain).

## Running

```
npm run typecheck      # strict tsc over src/ and benchmarks/
npm run dev            # backend, watch mode
npm run build          # compile to dist/
npm test               # vitest
npm run benchmark      # runs the 20 benchmark cases, writes cases/<case_id>.json

cd ui && npm run dev   # frontend on http://localhost:3000, separate terminal
```

### The UI

Two processes:

```
npm run dev            # agent backend on :4000, holds the loaded graph in memory
cd ui && npm run dev   # case-view UI on :3000
```

- `/` the investigation queue
- `/case/[id]` the case view: evidence with the query behind each claim, the
  initial and final recommendations side by side, and Approve / Reject on any
  action the permission gate routed to a human
- `/new` start an investigation on any transaction in the graph. Every input is
  a choice from the dataset (cardholder, then card, then transaction), and the
  backend rejects an id that does not exist, so the agent can never be pointed
  at a made-up entity.

The backend loads its dataset slice once, which takes about ten seconds, so the
UI stays responsive after the first request. Ad-hoc runs are written to
`cases/LIVE-<txnId>.json` and are excluded from the submission and from the
validator.

### Deploying

The UI is a normal Next.js app and deploys to Vercel with the project root set
to `ui/`. `npm run prebuild` vendors the 20 case files and the policy config
into `ui/data/`, so the queue and the case view work on a host that only
deploys `ui/`.

Live investigation needs the agent backend, and the backend needs the 224 MB of
prepared CSVs, so it does not fit a serverless host. Two options:

- **Read-only demo (simplest).** Deploy `ui/` to Vercel. The queue, case view,
  evidence, SAR narratives and the initial-to-final action contrast all work.
  `/new` reports that the backend is offline.
- **Full app.** Run both processes on one container host (Render, Railway, Fly)
  with the dataset present, then point the UI at the backend with
  `AGENT_API_URL`.

### Benchmark

`npm run benchmark` is the real validation target. It runs all 20 cases from
`data/HHGOA_IEEE/case_pack.csv` through the orchestrator and writes one answer
file per case to `cases/<case_id>.json`, which is what gets submitted. Run it
after any change to `src/orchestrator/`, `src/tools/`, or `graph/queries/`, not
just at the end of a phase. It currently prints a placeholder message: the
runner is wired up in phase 8 of `build_plan.md`.

The answer-file schema is fixed by the "Answer Format" section of the dataset
README and missing fields score zero, so phase 8 also ships a validator that
checks all 20 files against it before submission.
