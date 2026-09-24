# CLAUDE.md

This file is read automatically by Claude Code at the start of work in this repository. It governs *how* Claude Code should build this project. For *what* the AI agent being built should do, see `agent.md`. For *why* the system is structured this way, see `docs/architecture.md`.

## Project Summary

An agentic fraud investigation system built for the TigerGraph "Agentic Fraud Investigation HHGOA" hackathon. The agent investigates fraud signals using a TigerGraph knowledge graph, gathers evidence through GraphRAG-grounded reasoning, recommends next-best actions under an explicit permission model, and improves over time using case memory. Deadline: Sept 24, 2026, 11:59 PM IST — every decision should be made with that constraint in mind.

Read `docs/architecture.md` and `agent.md` in full before writing code in a new area of the repo. Don't re-derive architecture decisions already made there — follow them, and flag it explicitly if something in those docs turns out to be wrong once real implementation starts, rather than silently deviating.

## Repository Layout

```
graph/       TigerGraph schema, load jobs, GSQL queries
src/         backend: orchestrator, tools, LLM layer, memory, API
ui/          Next.js case-view frontend
data/        the HHGOA_IEEE dataset
cases/       the 20 answer files, <case_id>.json (the graded deliverable)
benchmarks/  the 20-case benchmark runner
config/      permissions.json, policy_rules.json and other runtime config
```

## Conventions

- **TypeScript, strict mode, everywhere** (backend and `ui/`). No `any` without a comment explaining why it's unavoidable.
- Backend code follows a NestJS-flavored module style even though this isn't a NestJS project: one responsibility per file, dependency injection via plain constructor params is fine, no god-files. Keep `src/tools/`, `src/llm/`, `src/orchestrator/`, `src/memory/` cleanly separated — the orchestrator calls tools and the LLM layer, it does not contain graph query logic or prompt text itself.
- Frontend: Next.js App Router, Tailwind for styling. Keep the UI functionally minimal per `docs/architecture.md` section 3.7 — this is a hackathon demo surface, not a product.
- All LLM prompts live in `src/llm/` as separate template files/exports, never inlined as string literals inside orchestrator or tool code.
- Every LLM call must validate its response against the JSON schema defined for it in `docs/architecture.md` section 3.4. If a response fails validation, retry once with an explicit correction instruction, then fail loudly (throw, log the raw response) rather than silently proceeding with malformed data.
- GSQL files live one-per-query in `graph/queries/`, named after the function that calls them (e.g. `findSharedDevicesAcrossAccounts.gsql`). Add a one-line comment at the top of each file stating which fraud pattern or investigation step it supports.

## Environment

Expect these in `.env` (see `.env.example` for the authoritative list, keep it in sync as new vars are added):

```
TIGERGRAPH_HOST=
TIGERGRAPH_GRAPH_NAME=
TIGERGRAPH_TOKEN=
ANTHROPIC_API_KEY=
```

There is no Postgres. It was in the original plan for case memory and pgvector, and was dropped once the brief turned out to require TigerGraph for vector storage and retrieval: graph, vectors and case records all live in TigerGraph. See `docs/architecture.md` §3.2 and §3.5.

Never commit real values. If a new integration needs a new env var, add it to `.env.example` in the same commit.

## Hard Constraints — Do Not Violate

- **There is no fraud ground-truth label in the transaction data.** Do not write code, tests, or mock data that assumes one exists. Fraud determination always flows from pattern evidence + policy + case history, surfaced through the reasoning layer.
- **Read the dataset README (`data/HHGOA_IEEE/README`) before implementing or changing any of the 5 fraud pattern queries.** Do not guess or infer pattern definitions from the hackathon brief alone — the brief describes the *category* of patterns, the README defines them precisely.
- **Every action beyond passive evidence-gathering must go through the permission gate** (`config/permissions.json`, enforced in the orchestrator). No action routed `L1` or `L2` may execute without an approval record, including in tests and demo runs — do not add a bypass "for convenience," even temporarily. If the demo needs to show an approved action quickly, call `approveAction` explicitly rather than weakening the gate.
- **Action names, pattern names, verdicts and routes are literal strings fixed by the dataset.** The fourteen action identifiers (`BLOCK_CARD`, `FILE_REPORT`, `VERIFY_WITH_CUSTOMER`, …), the seven `pattern` values, the three routes (`auto`/`L1`/`L2`) and the answer-file field names come from `data/HHGOA_IEEE/README.md` and are mirrored in `config/permissions.json` and `config/policy_rules.json`. Never rename, abbreviate, prettify or invent one: a mismatch scores zero for that case, and the planning docs were written before anyone read the dataset, so where they disagree with the README, the README wins.
- **Every recommended action must cite the policy rule id** (R1 to R10, in `config/policy_rules.json`) that produced it. An action with no rule behind it is not defensible and loses the next-best-action score.
- **Never fabricate GSQL syntax or TigerGraph MCP tool signatures.** If uncertain about MCP tool availability or a GSQL construct, check `https://github.com/tigergraph/tigergraph-mcp` or ask rather than guessing — a query that silently returns wrong/empty results is worse than one that errors clearly.
- **Case explanations must cite actual evidence retrieved in that case**, not generic reasoning. If an explanation can't point to a specific graph query result, policy chunk, or prior case, that's a bug in the evidence bundle, not something to paper over with better prompt wording.

## Testing & Validation

- There is no unit-test mandate for the hackathon, but every phase in `build_plan.md` has a stated Definition of Done — treat those as the acceptance tests for that phase.
- The real validation target is `benchmarks/run_benchmark.ts` against the 20 benchmark cases (Phase 8 of `build_plan.md`). Run it after any change touching `src/orchestrator/`, `src/tools/`, or `graph/queries/`, not just at the end.
- When a query or prompt change is made, spot-check its effect on at least one previously-passing benchmark case to catch regressions before moving on.

## Style / Output Preferences

- No em dashes in generated prose (docs, commit messages, comments, UI copy) — use commas, periods, or parentheses instead.
- Prefer clear, direct code over clever abstractions; this is a 2-day build, optimize for something that works and is explainable in a demo, not for long-term extensibility.

## How to Run

```
npm install
cp .env.example .env        # then fill in real values
npm run typecheck
npm run dev                  # backend
cd ui && npm run dev         # frontend, separate terminal
npm run benchmark            # runs all 20 benchmark cases
```
