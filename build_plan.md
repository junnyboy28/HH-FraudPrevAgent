# Build Plan — Phase-Wise Claude Code Prompts

How to use this file: work through the phases in order. Paste each **Prompt** block as-is into Claude Code inside the project directory (it will already have read `CLAUDE.md`, `agent.md`, and `docs/architecture.md` for context — don't repaste those into the prompt). Check the **Definition of done** before moving to the next phase. Don't start a phase until the previous one's DoD is met — a broken foundation compounds fast against a hard deadline.

> **Revised after Phase 1, once the dataset README had been read.** This plan, `docs/architecture.md` and `agent.md` were all written from the hackathon brief alone, before anyone had seen the data. Several things they specified turned out to be invented: the action names, the approval model, the LLM output schemas, the answer-file location, and the vector store. Those are fixed here and in the other docs, each marked with a revision note. The standing rule: where a planning doc disagrees with `data/HHGOA_IEEE/README.md`, the dataset README wins, because it is what the submission is scored against.

Two-day timeline this plan assumes:
- **Day 1:** Phases 0–4 (graph + core reasoning loop working end to end on one case)
- **Day 2:** Phases 5–9 (memory, actions, UI, full benchmark run, submission assets)

---

## Phase 0 — Repo Scaffold & Environment

**Goal:** working skeleton, no logic yet, so every later phase has somewhere to land.

**Prompt:**
```
Set up the repository skeleton described in docs/architecture.md section 5
(Repository Structure). Create the directory tree with placeholder files
(empty or minimal exports) for every path listed. Initialize:
- A TypeScript Node.js project at the repo root (strict mode on) for
  src/, graph/ tooling, and benchmarks/.
- A separate Next.js app under ui/ (App Router, TypeScript, Tailwind).
- A .env.example listing every environment variable referenced in
  CLAUDE.md's "Environment" section (TigerGraph, LLM API key).
- package.json scripts: dev, build, typecheck, test, benchmark.
- A README.md at root with one-paragraph project description and setup
  instructions (install, env setup, how to run the benchmark).
Do not implement any business logic yet — this phase is scaffolding only.
```

**Definition of done:** `npm install` succeeds, `npm run typecheck` passes with no errors, Next.js app boots to a blank page, folder structure matches architecture.md.

---

## Phase 1 — TigerGraph Schema & Data Load

**Goal:** the dataset is queryable as a graph.

**Prompt:**
```
Read the HHGOA_IEEE dataset README first (data/HHGOA_IEEE/README) and do
not proceed until you have the exact column names and the exact
definitions of the 5 documented fraud patterns.

Then, in graph/schema.gsql, define the TigerGraph schema described in
docs/architecture.md section 3.1: node types Account, Card, Transaction,
Device, IPAddress, Email, Address, Case, FraudPattern, PolicyDoc, and the
edge types listed there. Adjust node attributes to match the actual
dataset columns you just read — do not invent columns.

In graph/load/, write the GSQL loading jobs (or a data-prep script plus
GSQL LOAD statements) to ingest the transaction, identity, and closed-case
files into this schema. Include a small script that loads only the first
1,000 transactions for fast local iteration, and a full-load script for
the complete dataset.

Write graph/load/README.md documenting how to run both loads against
Savanna or Community Edition, and what to check to confirm the load
succeeded (expected node/edge counts).
```

**Definition of done:** schema installs cleanly on a fresh TigerGraph instance; sample load runs without errors; a manual `SELECT count` per node/edge type returns non-zero, sane numbers.

---

## Phase 2 — Core Fraud Pattern GSQL Queries

**Goal:** the queries that ARE the investigation-accuracy score.

**Prompt:**
```
In graph/queries/, implement each query listed in docs/architecture.md
section 3.1 as its own .gsql file:
- getEntityNeighborhood
- findSharedDevicesAcrossAccounts
- findVelocityBursts
- findLinkedFraudHistory
- findSimilarClosedCases
- one query per remaining documented fraud pattern (use the exact
  definitions from the dataset README you read in Phase 1 — list which
  pattern each query implements in a comment at the top of the file)

For each query, also write a small test script in graph/queries/tests/
that runs it against a known account/transaction ID from the sample load
and prints the result, so correctness can be eyeballed before the LLM
layer depends on it.

Write graph/queries/README.md summarizing what each query returns and
what it's used for in the investigation flow (reference the 8-step flow
in agent.md).
```

**Definition of done:** every query runs against the sample-loaded graph and returns plausible, non-empty results for at least one known test entity; each query's purpose is traceable to a specific step in agent.md's investigation flow.

---

## Phase 3 — GraphRAG Retrieval Layer

**Goal:** policy and pattern grounding, per docs/architecture.md section 3.2.

**Prompt:**
```
Implement src/tools/graphrag.ts:
1. A one-time ingestion script (scripts/ingest-policy-docs.ts) that chunks
   the Fraud Policy section of data/HHGOA_IEEE/README.md (including rules
   R1-R10, the SAR criteria and the stopping criteria), the 5 pattern
   descriptions, and the closed-case narratives from
   closed_cases_history.csv, embeds each chunk, and stores it in
   TigerGraph's vector store on PolicyDoc and Case vertices.
2. A retrieve(evidenceBundle) function that takes the structured evidence
   from the graph tool (not raw text) and returns the top-k most relevant
   policy/pattern chunks, each with the rule id or section it came from so
   the case can cite it.

Also implement src/tools/graph-tool.ts as a thin wrapper around the
TigerGraph MCP calls for each query written in Phase 2, exposing one
typed function per query (e.g. getSharedDevices(accountId): Promise<...>)
with the raw MCP call details hidden behind this interface.

Write a script scripts/build-evidence-bundle.ts that, given an account or
transaction ID, calls the graph tool functions and graphrag.retrieve, and
assembles the Evidence Context Bundle JSON shape described in
docs/architecture.md section 3.2. Print it for one sample case so we can
inspect the shape before wiring it to the LLM.
```

**Definition of done:** running the evidence-bundle script for a sample account produces a well-formed JSON bundle containing both graph evidence and relevant policy text, inspected and confirmed to make sense manually.

---

## Phase 4 — Agent Orchestrator + LLM Reasoning (single case, end to end)

**Goal:** the full 8-step loop works on one case, unblocking everything after it.

**Prompt:**
```
Implement the CaseOrchestrator state machine in src/orchestrator/ per
docs/architecture.md section 3.3 and the states/transitions defined in
agent.md. Each state should be a separate method, and every transition
must write a record to the case (in-memory for now, persistence comes in
Phase 5).

Implement src/llm/ with one prompt template + structured-output parser per
LLM call listed in docs/architecture.md section 3.4 (pattern
identification, risk assessment, evidence sufficiency, next-best-action,
explanation). Use the exact JSON schemas from that table. Validate LLM
output against the schema and retry once on a malformed response before
failing loudly.

Wire the orchestrator to call: graph-tool -> graphrag -> LLM reasoning
calls, in the order defined by the 8-step flow. Stub the evidence-gathering
and action-execution calls for now (Phase 6 implements them for real) —
just log what would be called.

Write scripts/run-single-case.ts that triggers the orchestrator for one
sample account/transaction and prints the full case trace (every step,
every LLM output) to the console.
```

**Definition of done:** `run-single-case.ts` completes without crashing, produces a coherent trace through all 8 steps, and the LLM outputs are schema-valid and reference actual evidence (not hallucinated data).

---

## Phase 5 — Case Memory (TigerGraph)

**Goal:** persistence + the "learn from past cases" requirement.

**Prompt:**
```
Implement src/memory/ per docs/architecture.md section 3.5:
- A writeCase(caseState) function called at orchestrator step 8 that
  writes the Case vertex (source="agent") plus its INVOLVES, ON_CARD,
  CONNECTED_TO, MATCHES_PATTERN and SIMILAR_TO edges, and embeds the case
  summary into the vector store. It must set written_to_graph and
  graph_case_id for the answer file.
- A findSimilarCases(caseFeatures) function combining graph-linked
  similar cases (shared device, card, region or pattern) with vector
  similarity on case narratives, deduplicated, returning the top-k with
  their outcomes. The 5,565 closed cases are already loaded as Case
  vertices with source="closed_history", so this works from the first
  case onward rather than only after the agent has built history.
  Returned closed-case ids go into the answer file's
  similar_prior_cases.

Wire findSimilarCases into the orchestrator's INVESTIGATING and ASSESSING
states so retrieved past cases become part of the Evidence Context Bundle
and influence the LLM's risk assessment and next-best-action calls.

Update run-single-case.ts to run twice in a row on related test accounts
and confirm the second run's case trace references the first run's case
as a similar prior case.
```

**Definition of done:** running the same or a related case twice shows the second run's evidence bundle including the first case as a similar prior case, and TigerGraph persists the case, its edges and its summary embedding correctly after a fresh run.

---

## Phase 6 — Actions Layer & Permission Gate

**Goal:** the "operates within policies and permissions" requirement, made demonstrable.

**Prompt:**
```
config/permissions.json and config/policy_rules.json already exist and are
the contract. Do not regenerate or rename anything in them: the 14 action
identifiers, the 3 routes and the rule ids are fixed by the dataset.

Implement src/tools/actions/ so each of the 14 files is a mock async
function that logs the action and returns a plausible mock result (no
real external calls).

Implement a permission gate in src/orchestrator/ that, before executing
any action, resolves its route from config/permissions.json:
- it must evaluate route_conditions, not just read `route`. BLOCK_CARD is
  L1 at exposure <= $2,500 and L2 above it, so the gate resolves against
  the case's exposure_usd.
- `auto` actions execute immediately and are recorded with
  executed: true
- `L1` and `L2` actions are recorded with status "pending_approval", the
  resolved route, and NOT executed, plus an
  approveAction(caseId, actionId) function that executes them once
  approved.

Implement the rule engine that selects actions from
config/policy_rules.json, so every recommendation carries the rule id
that produced it. R1, R7 and R10 are prohibitions: the gate must refuse a
blocking action they forbid, even if the LLM recommends it.

Wire this into the orchestrator's step 6 (next action) and step 5
(evidence-gathering actions), replacing the stubs from Phase 4. Step 5
must record each evidence request as {type, asked_after_step,
assumed_response} and re-run action selection afterwards, so
next_best_actions.initial and .final can differ.

Write a test in src/orchestrator/tests/ that triggers a case which should
recommend BLOCK_CARD and confirms it is queued with the right route, not
executed, until approveAction is called. Add a second test asserting
BLOCK_CARD resolves to L1 below $2,500 and L2 above it.
```

**Definition of done:** an `auto` action executes and is logged; an `L1`/`L2` action is queued with its resolved route, not executed, and only runs after an explicit approval call; the exposure-conditional route for BLOCK_CARD resolves both ways correctly; a rule-forbidden block is refused even when recommended; all of it is visible in the persisted case record.

---

## Phase 7 — UI: Case View

**Goal:** the demonstration surface (10% of the grade, and load-bearing for the demo video).

**Prompt:**
```
In ui/, build a single case-view page at /case/[id] per
docs/architecture.md section 3.7:
- Evidence timeline (source, evidence type, timestamp, summary)
- Pattern matches with confidence scores
- Risk/confidence indicator (simple, clear — a labeled gauge or colored
  badge is enough, don't over-design)
- Reasoning trace: the explanation text from step 7, not a raw LLM
  transcript
- Recommended action(s), with an Approve / Reject control for any action
  marked pending_approval, calling the approveAction backend function
  from Phase 6
- Case status badge (open/closed, risk level)

Build a minimal API route (or reuse src/api/) that serves case data from
TigerGraph to this page. Add a simple /cases list page linking to each
case by ID, just for demo navigation — no auth, no multi-user concerns.

Show the approval route (auto / L1 / L2) next to every recommended
action, and show next_best_actions.initial and .final side by side with
what_changed between them. That contrast is the clearest on-screen proof
of the "revises its recommendation as evidence arrives" requirement,
which is the heaviest-weighted thing the demo can show.

Keep styling clean and readable over elaborate — this needs to read
clearly in a 3-5 minute demo video, not win a design award.
```

**Definition of done:** navigating to /case/[id] for a case produced by run-single-case.ts renders all the required sections correctly, and approving a pending action visibly updates its status without a page reload requiring a manual refresh of data (or a simple refresh is acceptable if time-constrained).

---

## Phase 8 — Full Benchmark Run & Submission Files

**Goal:** the actual graded deliverable — this phase is non-negotiable and should not be rushed.

**Prompt:**
```
Re-read the "Answer Format" section of data/HHGOA_IEEE/README.md before
writing any code. It is authoritative over agent.md section 6 if they
ever disagree.

Implement benchmarks/run_benchmark.ts to:
1. Load the 20 cases from data/HHGOA_IEEE/case_pack.csv (note the file
   has quoted fields containing commas, so parse it properly).
2. Run each through the full CaseOrchestrator end to end, including any
   evidence-gathering loops it triggers, measuring tool_calls, tokens and
   latency_s as it goes.
3. Write each answer to cases/<case_id>.json, exactly 20 files.
4. Ensure each case is also written to the graph via the Phase 5 memory
   writer, and that written_to_graph and graph_case_id reflect it.

Then write a validator (benchmarks/validate_answers.ts) and run it. It
must fail loudly on:
- a missing file, or any missing/extra top-level field
- an action name outside the 14 in config/permissions.json
- a pattern outside the 7 allowed values
- a route that disagrees with what the permission gate resolves
- sar.file true without a narrative, or disagreeing with whether
  FILE_REPORT appears in next_best_actions.final
- a legitimate verdict with non-empty affected_txn_ids, non-zero
  exposure_usd, or sar.file true
- any txn/card/customer/case id that does not exist in the dataset
- a reason field that cites no policy rule id

After running, print a summary table: case ID, verdict, fraud
probability, pattern, exposure, actions before and after evidence, and
whether a SAR was filed. Sanity-check it: roughly half the 20 cases are
expected to be legitimate, so a run that blocks nearly everything is
wrong even if every file validates.
```

**Definition of done:** all 20 cases run without errors, `validate_answers.ts` passes clean on all 20 files, every id in the output exists in the dataset, and the summary table is defensible on manual review (a plausible spread of verdicts rather than everything blocked or everything cleared, and no missing SAR where the criteria clearly apply).

---

## Phase 9 — Demo, Blog Post, Social Post (non-code)

**Goal:** the remaining submission assets. Not a Claude Code prompt in the same sense — use Claude Code (or Claude directly) to help draft, but these need human judgment and a human voice pass before submitting.

**Prompt:**
```
Based on the final codebase, docs/architecture.md, and the benchmark
output from Phase 8, draft:
1. A script/outline for a 3-5 minute demo video: show one case going
   through the full flow live (trigger -> evidence -> uncertainty ->
   more evidence -> action -> explanation), then a fast montage of the
   case list showing variety across the 20 benchmark cases.
2. A technical blog post draft covering: what was built, the
   architecture (summarize docs/architecture.md, don't just paste it),
   how TigerGraph specifically was used (schema + the pattern queries),
   the agentic capabilities implemented (the permission gate and the
   evidence-sufficiency loop are the strongest talking points), what was
   learned, and what would be improved with more time (reference the cut
   list in docs/architecture.md section 8 honestly).
3. A short social post draft for X/LinkedIn summarizing the approach and
   tagging @TigerGraphDB, linking to the blog post.
Keep all three as editable drafts, not final copy — flag anywhere a
specific claim needs to be verified against the actual final benchmark
results before publishing.
```

**Definition of done:** demo script, blog draft, and social post draft all exist, are factually consistent with the actual final benchmark run (not aspirational), and are ready for a final human edit pass before the Sept 24 submission.
