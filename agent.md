# Agent Specification — Fraud Investigation & Next-Best-Action Agent

This document specifies the behavior of the AI agent being built (not the coding assistant building it — see `CLAUDE.md` for that). It is the contract the orchestrator, tools, and LLM prompts in `src/` must implement. `docs/architecture.md` explains why the system is shaped this way; this document defines precisely what the agent does at each step, what it's allowed to do, and what its outputs look like.

## 1. Purpose

Given a fraud signal, the agent investigates it the way a human fraud analyst would: gather evidence from the graph and prior cases, assess how confident it can be, get more evidence if it can't yet be confident, then recommend or take a defensible next action, within a fixed permission model, and explain every step of that reasoning.

## 2. Triggers

The agent starts an investigation when it receives one of:

| Trigger type | Source | Initial payload |
|---|---|---|
| Risk signal | Bank's fraud detection model score on a transaction | `transaction_id`, `risk_score` |
| Customer report | Customer disputes/reports a transaction | `transaction_id` or `account_id`, `customer_statement` |
| Analyst request | A fraud analyst manually opens an investigation | `account_id` and/or `transaction_id`, `analyst_notes` |

Any trigger produces the same downstream flow — the trigger type is recorded on the case and may influence which evidence is gathered first (e.g. a customer report starts with the disputed transaction's neighborhood; a risk-score trigger starts with the pattern queries most correlated with that score band), but does not change the flow's structure.

## 3. Investigation Flow (state machine)

This is the authoritative version of the 8-step flow from the hackathon brief, with explicit inputs/outputs per state. The orchestrator (`src/orchestrator/`) implements exactly these states and transitions.

### State: `TRIGGERED`
- Input: trigger payload (§2)
- Action: create a `Case` record (TigerGraph `Case` vertex, `source="agent"`), status `TRIGGERED`
- Output: `case_id`
- Transition: → `INVESTIGATING`

### State: `INVESTIGATING`
- Input: `case_id`, trigger entities
- Action: call `getEntityNeighborhood` to pull the local subgraph; call `findSimilarClosedCases` and `findLinkedFraudHistory` against case memory
- Output: initial evidence set + list of similar prior cases
- Transition: → `EVIDENCE_GATHERED`

### State: `EVIDENCE_GATHERED`
- Input: current evidence set
- Action: run the relevant fraud-pattern queries (§4) against the trigger entities; retrieve policy/pattern text via GraphRAG; assemble the Evidence Context Bundle (schema in §6)
- Output: Evidence Context Bundle
- Transition: → `ASSESSING`

### State: `ASSESSING`
- Input: Evidence Context Bundle
- Action: LLM call — pattern identification, then risk assessment (schemas in §6)
- Output: `pattern`, `fraud_probability`, `verdict`, `key_factors`
- Transition: LLM call — evidence sufficiency check. If `sufficient: true` → `ACTION_SELECTED`. If `sufficient: false` → `NEEDS_MORE_EVIDENCE`

### State: `NEEDS_MORE_EVIDENCE`
- Input: `missing_evidence`, `requested_action` from the sufficiency check
- Action: execute the requested evidence-gathering action (§5, `auto` route only, see the permission model in §7) through the permission gate
- Output: new evidence appended to the case
- Transition: → `EVIDENCE_GATHERED` (loop). Cap at 3 evidence-gathering cycles per case — if still insufficient after 3 cycles, transition to `ACTION_SELECTED` with the case forced into an `ESCALATE_TO_ANALYST` recommendation rather than looping indefinitely.

### State: `ACTION_SELECTED`
- Input: full case state (all evidence, patterns, risk assessment, similar prior cases and their outcomes)
- Action: LLM call — next-best-action selection (schema in §6). For each recommended action, run it through the permission gate (§7): `auto` actions execute and are recorded as `executed: true`; `L1` and `L2` actions are recorded with their resolved route and `status: pending_approval`, and are not executed.
- Output: one or more recommended/executed actions, each with its route and the policy rule id behind it
- Transition: → `EXPLAINED`

### State: `EXPLAINED`
- Input: full case state including actions taken/queued
- Action: LLM call — explanation generation (schema in §6), referencing the specific evidence, patterns, and prior cases that drove the decision
- Output: human-readable case explanation
- Transition: → `MEMORY_UPDATED`

### State: `MEMORY_UPDATED`
- Input: full, final case state
- Action: write the case to TigerGraph (`Case` vertex plus `INVOLVES`, `ON_CARD`, `CONNECTED_TO`, `MATCHES_PATTERN` and `SIMILAR_TO` edges) and embed its summary into the vector store
- Output: case persisted, available for future `findSimilarClosedCases` lookups
- Transition: → `CLOSED` (or remains open/monitored per the action taken — not every case closes immediately; a `MONITOR_CARD` action, for example, keeps the case in an open-monitoring status)

## 4. Fraud Patterns

The agent must recognize the 5 documented patterns defined in the dataset README (`data/HHGOA_IEEE/README.md`) — **do not infer pattern definitions from this document alone; read the README for the authoritative definitions before implementing detection logic.** Once read, list them here with their exact names and the GSQL query (from `docs/architecture.md` §3.1) that detects each:

| Pattern ID | Name (from dataset README) | Detection query |
|---|---|---|
| P1 | `card_testing`: three or more tiny online authorizations (often under $5), then a larger purchase. Confirmed by the sequence itself. Policy R5 | `graph/queries/findCardTestingSequences.gsql` |
| P2 | `card_not_present_fraud`: the number used online without the card; amounts and products that don't fit the cardholder's history, often a burst of two to four within 48 hours. One unusual online purchase alone is ambiguous: verify. Policy R1 to R4 | `graph/queries/findCardNotPresentBursts.gsql` |
| P3 | `card_not_present_new_device`: as P2, with the identity record marking the device `New` for this account, sometimes behind a proxy. Stronger than P2, still not proof | `graph/queries/findNewDeviceCardNotPresent.gsql` |
| P4 | `out_of_region_use`: card-present purchases in a billing region the cardholder has no history in, while normal activity continues at home. Several days in one new region is a trip, not a clone. Policy R2, R3 | `graph/queries/findOutOfRegionUse.gsql` |
| P5 | `account_takeover`: mixed-channel activity inconsistent with the cardholder, often with device and match-flag anomalies, pointing to stolen credentials rather than a stolen number | `graph/queries/findAccountTakeoverSignals.gsql` |

The pattern IDs above are the literal values the answer format's `pattern` field accepts, along with `undocumented` and `none`. They are loaded as `FraudPattern` vertices by the data load, so a case can cite one by exactly the string it must report. The detection queries are written in the graph-query phase; the dataset README is at `data/HHGOA_IEEE/README.md`.

The agent is also expected to be able to flag activity that doesn't cleanly match any documented pattern (the brief notes not every fraud pattern present in the data is documented) — when evidence suggests fraud but no `FraudPattern` match is found, the agent records `pattern_matched: "undocumented"` with its own description of the observed structure, rather than forcing a fit to the nearest documented pattern.

## 5. Tools Available to the Agent

| Tool | Type | Used in states |
|---|---|---|
| `getEntityNeighborhood` | Graph query | `INVESTIGATING` |
| `findSharedDevicesAcrossAccounts` | Graph query (pattern) | `EVIDENCE_GATHERED` |
| `findVelocityBursts` | Graph query (pattern) | `EVIDENCE_GATHERED` |
| `findLinkedFraudHistory` | Graph query | `INVESTIGATING` |
| `findSimilarClosedCases` | Graph query + case memory | `INVESTIGATING` |
| `graphrag.retrieve` | Policy/pattern retrieval | `EVIDENCE_GATHERED` |

**Actions.** The fourteen below are the bank's entire action vocabulary, defined in the Fraud Policy section of `data/HHGOA_IEEE/README.md` and mirrored in `config/permissions.json`. These identifiers are literal: the answer format requires the exact string, and an action name that is not one of these scores zero for that case. Routes are `auto` (the agent may execute), `L1` (team lead approves), `L2` (fraud manager approves).

| Action | Route | Used in states |
|---|---|---|
| `VERIFY_WITH_CUSTOMER` | `auto` | `NEEDS_MORE_EVIDENCE` (evidence request `customer_validation`), `ACTION_SELECTED` |
| `STEP_UP_AUTH` | `auto` | `NEEDS_MORE_EVIDENCE` (evidence request `step_up_auth`), `ACTION_SELECTED` |
| `ESCALATE_TO_ANALYST` | `auto` | `NEEDS_MORE_EVIDENCE` (evidence request `analyst_info`), `ACTION_SELECTED`, or forced after 3 cycles |
| `ALLOW_TRANSACTION` | `auto` | `ACTION_SELECTED` |
| `MONITOR_CARD` | `auto` | `ACTION_SELECTED` |
| `MONITOR_CONNECTED_CARDS` | `auto` | `ACTION_SELECTED` |
| `WARN_CUSTOMER` | `auto` | `ACTION_SELECTED` |
| `GENERATE_REPORT` | `auto` | `ACTION_SELECTED` |
| `CREATE_CASE` | `auto` | `INVESTIGATING` onward, per `case_criteria` |
| `CLOSE_NO_FRAUD` | `auto` | `ACTION_SELECTED` |
| `DECLINE_TRANSACTION` | `L1` | `ACTION_SELECTED` |
| `BLOCK_CARD` | `L1`, or `L2` when exposure > $2,500 | `ACTION_SELECTED` |
| `BLOCK_ALL_CARDS` | `L2` | `ACTION_SELECTED`, only under R10 |
| `FILE_REPORT` | `L2` | `ACTION_SELECTED`, only when `sar_criteria` are met |

Action selection is rule-driven, not free-form: `config/policy_rules.json` holds R1 to R10, and every recommendation must cite the rule id that produced it.

## 6. Output Schemas

**Evidence Context Bundle** (input to the LLM at `ASSESSING`)
```json
{
  "case_id": "string",
  "trigger": { "type": "risk_signal|customer_report|analyst_request", "payload": {} },
  "entities": { "accounts": [], "transactions": [], "devices": [], "shared_identifiers": [] },
  "pattern_query_results": [ { "pattern_id": "P1", "matched": true, "details": {} } ],
  "similar_prior_cases": [ { "case_id": "string", "outcome": "confirmed_fraud|cleared", "shared_entities": [] } ],
  "policy_context": [ { "source": "string", "text": "string" } ]
}
```

**Risk assessment output**
```json
{ "fraud_probability": 0.0, "verdict": "fraud|legitimate|uncertain", "key_factors": ["string"] }
```

`fraud_probability` is scored for calibration, so it must reflect what the evidence supports rather than the trigger's risk score. Half the benchmark cases are legitimate.

**Evidence sufficiency output**
```json
{ "sufficient": true, "missing_evidence": ["string"], "requested_action": "customer_validation|step_up_auth|analyst_info|null" }
```

**Next-best-action output**
```json
{
  "actions": [
    { "action": "BLOCK_CARD", "route": "auto|L1|L2", "reason": "R2 and R5: customer denied; exposure $268 is under $2,500" }
  ]
}
```

`action` must be one of the fourteen identifiers in §5. `reason` must cite the policy rule id. The orchestrator, not the LLM, is authoritative on `route`: whatever the model returns is overwritten by the permission gate's resolution from `config/permissions.json`.

### The answer file

This is the graded deliverable, one `cases/<case_id>.json` per benchmark case. The
schema is fixed by the "Answer Format" section of `data/HHGOA_IEEE/README.md`;
that document is authoritative and missing fields score zero for that part.

```json
{
  "case_id": "HHG-001",
  "case": {
    "status": "open|closed_fraud|closed_legitimate|escalated",
    "verdict": "fraud|legitimate|uncertain",
    "fraud_probability": 0.0,
    "pattern": "card_testing|card_not_present_fraud|card_not_present_new_device|out_of_region_use|account_takeover|undocumented|none",
    "pattern_description": "required when pattern is undocumented, otherwise \"\"",
    "affected_txn_ids": ["string"],
    "first_suspicious_txn_id": "string or \"\"",
    "connected_card_ids": ["string"],
    "connected_device_profiles": ["DeviceInfo | OS | browser | screen"],
    "exposure_usd": 0.0,
    "evidence": [
      { "claim": "string", "source": "graph|document|customer|external", "ref": "query name, document section, or request id", "entity_ids": ["string"] }
    ],
    "similar_prior_cases": ["CC-0141"],
    "summary": "two to six sentences",
    "written_to_graph": true,
    "graph_case_id": "string or \"\""
  },
  "evidence_requests": [
    { "type": "customer_validation|step_up_auth|analyst_info", "asked_after_step": 4, "assumed_response": "string" }
  ],
  "next_best_actions": {
    "initial": [ { "action": "string", "route": "auto|L1|L2", "reason": "cite the policy rule" } ],
    "final": [ { "action": "string", "route": "auto|L1|L2", "reason": "cite the policy rule" } ],
    "what_changed": "one or two sentences, or \"nothing\""
  },
  "sar": {
    "file": true,
    "reason": "why file, or why not; cite the policy rule",
    "narrative": "six to twelve sentences covering who, what, when, where, how, why suspicious",
    "subjects": ["string"],
    "total_amount_usd": 0.0,
    "activity_dates": ["YYYY-MM-DD", "YYYY-MM-DD"]
  },
  "stop_reason": "string",
  "tool_calls": 0,
  "tokens": 0,
  "latency_s": 0.0
}
```

Constraints that are easy to get wrong:

- Every ID must exist in the dataset. Invented IDs score zero.
- For a `legitimate` verdict: `affected_txn_ids` is `[]`, `exposure_usd` is `0`, `sar.file` is `false`.
- When `sar.file` is `false`: `narrative` is `""`, `subjects` is `[]`, `total_amount_usd` is `0`, `activity_dates` is `[]`.
- `sar.file` must agree with whether `FILE_REPORT` appears in `next_best_actions.final`.
- If nothing was requested, `final` equals `initial` and `what_changed` is `"nothing"`.
- `tool_calls`, `tokens` and `latency_s` are per-case measurements, so the orchestrator has to instrument them from the start rather than have them bolted on at benchmark time.

## 7. Permission Model

Source of truth: `config/permissions.json`, enforced by the orchestrator's permission gate. See `docs/architecture.md` §3.6 for the full table.

Three routes, not a boolean. `auto` actions the agent may execute itself. `L1` needs a team lead, `L2` needs a fraud manager; both are recommended with the route stated and then wait for a human. One route is conditional: `BLOCK_CARD` is `L1` at exposure of $2,500 or less and `L2` above it, so the gate has to resolve the route against the case's `exposure_usd` rather than read a fixed value.

The agent **recommends**; only the permission gate decides whether a recommendation becomes an execution. This distinction must be visible in every case record — never collapse "recommended" and "executed" into one status.

## 8. Stop Condition

The policy (section 6 of the dataset README, mirrored in `config/policy_rules.json`) defines when to stop. Any one of these is sufficient:

1. Fraud probability is at or above 0.85, or at or below 0.15, **supported by at least two independent pieces of evidence**. One strong signal is not enough on its own.
2. A verification response settles the question.
3. Further steps are unlikely to change the decision.

Plus one build guardrail, not from the policy: three evidence-gathering cycles without reaching sufficiency forces `ESCALATE_TO_ANALYST` (§3 `NEEDS_MORE_EVIDENCE`).

Every case records `stop_reason` explaining which of these applied. Investigations that run past a defensible decision are marked down, and so are investigations that stop before one, so this is scored in both directions.

A case is never left in an indefinite "still investigating" state with no next action recorded: every case reaches `ACTION_SELECTED` one way or another.

## 9. Explanation Requirements

Every case's explanation (state `EXPLAINED`) must answer, in plain language:
- What evidence was used, and where it came from (graph query, prior case, or gathered evidence)
- If additional evidence was requested: what was missing and why that specific action was chosen to fill the gap
- Why the selected action(s) were chosen over the alternatives, referencing the risk assessment and any similar prior case outcomes

- The policy rule id behind each recommended action. Policy section 7 requires the citation, and `reason` fields that do not name a rule are incomplete.

An explanation that could apply to any case regardless of its specific evidence is a failure of this requirement, not an acceptable summary.

## 10. Simulated Responses

The dataset provides no customer or analyst replies. When the agent takes an evidence-gathering action it simulates the response, records it in `evidence_requests[].assumed_response`, and lets `next_best_actions.final` follow from it.

This is a scoring-relevant design decision, not a detail. R2 (customer denies) leads to `BLOCK_CARD`, R3 (customer confirms) leads to `CLOSE_NO_FRAUD`, and roughly half the benchmark cases are legitimate. An agent that always assumes denial will block legitimate customers and score badly on next-best-action. The simulation must therefore be driven by the evidence already gathered, not by a fixed answer, and the assumption must be stated plainly enough that a judge can see it was reasoned rather than convenient.
