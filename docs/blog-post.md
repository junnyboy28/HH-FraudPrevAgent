# Building a fraud investigation agent on TigerGraph in two days

*Written for the TigerGraph x Hacker House Goa hackathon. Repo:
https://github.com/junnyboy28/HH-FraudPrevAgent*

A fraud analyst who gets an alert spends the next half hour doing the same
things every time: pull the cardholder's history, check what device the purchase
came from, look for other accounts on that device, dig out similar closed cases,
read the policy, decide what they are allowed to do, and write it up so a
regulator could read it later. Thousands of alerts, one analyst at a time.

We built an agent that does that job on a TigerGraph knowledge graph and shows
its work. This is what it does, how it is put together, and the parts where the
data pushed back.

---

## What we built

Given a fraud alert, the agent runs an eight-step flow: trigger, investigate,
gather evidence, assess uncertainty, gather more evidence if the policy calls
for it, recommend a next best action, explain the decision, and write the case
back into the graph as memory.

The output is twenty answer files, one per benchmark case, each containing the
internal case record, a suspicious activity report when the policy demands one,
and the recommended actions **before and after** the agent asked for more
evidence.

The spread across the twenty cases:

| | |
|---|---|
| Legitimate | 9 |
| Uncertain | 6 |
| Fraud | 5 |
| Cards blocked | 5 |
| Reports filed | 5 |
| Recommendation revised after evidence | 6 |

That distribution is the point. The dataset README warns that roughly half the
cases are legitimate and that "an agent that blocks everything scores badly". An
agent tuned to look decisive would block twenty and be wrong ten times.

---

## Architecture

```
Trigger
  -> CaseOrchestrator (explicit 8-state machine)
       -> Evidence layer        neighbourhood, timeline, profile,
                                shared devices, prior fraud, similar cases
       -> Pattern detection     5 documented patterns + undocumented rings
       -> GraphRAG              policy chunks retrieved from vectors in TigerGraph
       -> Policy engine         R1..R10, 14 action identifiers, auto/L1/L2 routing
       -> Claude                case summary and SAR narrative, from evidence only
       -> Case writer           FraudCase vertex + edges back into TigerGraph
```

The division of labour is the most important design decision we made, so it is
worth stating plainly: **the LLM writes prose, and nothing else.** Pattern
detection, action selection, approval routing and the stopping rule are all
deterministic code reading config. That is what makes the permission model
auditable instead of something you hope the prompt enforced.

---

## How TigerGraph is used

**Schema.** Nine vertex types and fifteen edge types. `Customer`, `PaymentCard`,
`Transaction`, `DeviceProfile`, `EmailDomain`, `BillingRegion`, `FraudCase`,
`FraudPattern`, `PolicyDoc`.

**Load.** A prep step normalises the raw dataset into 21 load-ready CSVs, then a
GSQL loading job ingests them over REST in chunks. The full load is 224 MB in 90
seconds, with every file reporting `validObject == validLine`, zero rejects:

| | |
|---|---|
| Customer | 13,553 |
| PaymentCard | 14,317 |
| Transaction | 590,742 |
| DeviceProfile | 9,706 |
| FraudCase | 5,565 closed + the agent's own |
| MADE / NEXT_TXN / SHARED_BY edges | 590,742 / 576,425 / 67,908 |

**Queries.** Six GSQL retrieval queries: the neighbourhood of a flagged
transaction, a card's timeline, a cardholder's baseline profile, shared devices
across accounts, linked fraud history, and similar closed cases.

**A graph algorithm.** `findDeviceRings` runs connected components over the
bipartite `Customer <-> DeviceProfile` graph by iterative min-label propagation.
This is the one place an algorithm clearly beats a traversal: "who shares this
device" is one hop, but "which clusters of cardholders and devices form a
connected group anywhere in the graph" is a labelling problem.

**Vectors and GraphRAG.** The bank's fraud policy, the five pattern definitions
and the regulatory references are chunked into 29 `PolicyDoc` vertices, each
carrying a 256-dimension embedding as a vertex attribute. Retrieval is triggered
per case, and the query is *the graph evidence the investigation just gathered*.
So the policy that comes back is the policy that matches what was actually
found. All twenty cases cite retrieved policy chunks by id.

**Case memory, both directions.** The agent retrieves from the bank's 5,565
closed cases and writes its own cases back as `FraudCase` vertices with
`INVOLVES` and `MATCHES_PATTERN` edges. Memory is part of the graph, not a log
file beside it.

---

## Three things the data taught us

### 1. The dataset references cards that do not exist in the transaction file

`case_pack.csv` and `closed_cases_history.csv` both identify cards as
`C01234-K1`. `transactions.csv` has no `card_id` column at all.

We had to recover the rule. Two hypotheses failed: the `card2`–`card6` tuple
scored 39%, and first-seen ordering scored 93%. The actual rule:

> Within a customer, a card is identified by its **`card6`** value (`credit`,
> `debit`, or empty). Sort that customer's distinct `card6` values ascending.
> The `-KN` suffix is the position in that order.

It reproduces **14,955 of 14,955** transaction-to-card labels in the closed
cases and **20 of 20** flagged transactions in the case pack. The prep script
re-runs both checks on every run and refuses to finish if either disagrees, so a
wrong card map can never silently reach the graph.

### 2. A device profile is not a device fingerprint

The answer format wants device profiles as `DeviceInfo | OS | browser | screen`.
Treat that as identity and you invent fraud rings out of everyone who owns the
same laptop. The distribution:

| Cards sharing a profile | Profiles |
|---|---|
| 1 | 4,915 |
| 2–3 | 2,251 |
| 4–10 | 1,578 |
| 11+ | 962 |

One profile, `" | | |"` — literally no device information — covers 1,013 cards.
`Windows \| Windows 10 \| chrome 63.0 \| 1920x1080` covers 842.

Our first fix was a cardinality ceiling, and it was wrong in the other
direction: it discarded HHG-014, whose trigger text explicitly says several
cards share an unusual device profile. That case is
`SM-G935F Build/NRD90M | Android 7.0 | chrome 62.0 for android | 1920x1080`
across 51 cards.

The real discriminator is **specificity, not count**. A concrete device build
shared by 51 cardholders is a ring. A platform string shared by 842 is noise.
High cardinality on a specific handset is the signal, not a reason to discard.

### 3. Calibrate every signal against its base rate

Two signals that look damning are not:

| Signal | Frequency in the dataset |
|---|---|
| Device marked `New` for the account | **42.8%** of identity records |
| Identity match status other than `:2` | **58.4%** |
| Match status `0` or `-1` | **0.3%** |

We initially treated "new device" and "non-standard match status" as evidence.
`account_takeover` fired on 8 of 20 cases. After measuring the base rates and
requiring each signal to deviate from the cardholder's *own* history, it fires
on 1. The README says it plainly: people buy new phones.

---

## Agentic capabilities

**Uncertainty and revision.** Policy rule R1 forbids blocking on a single weak
signal below 0.70 probability. When that triggers, the agent asks the customer
to validate, simulates the response (the dataset provides no replies), records
the assumption, and re-runs action selection. Six of twenty cases changed
recommendation as a result, and both the initial and final lists are in the
answer file.

The simulation is evidence-driven on purpose. R2 (denial) leads to blocking and
R3 (confirmation) leads to closing, so an agent that always assumes denial would
block legitimate customers. Ours assumes denial only where the graph evidence
already supports fraud, confirmation where the activity fits the cardholder's
history, and no reply where it is genuinely ambiguous.

**Permissions.** Fourteen action identifiers from the policy, three routes.
`auto` executes, `L1` and `L2` are recommended and wait for a human. One route
is conditional: `BLOCK_CARD` resolves to L1 at or below $2,500 exposure and L2
above it, evaluated from the case. Rules R1, R7 and R10 are prohibitions applied
last, so a forbidden block is stripped even if everything else argued for it.

**Stopping.** Policy section 6: stop at probability at or above 0.85 or at or
below 0.15 with at least two independent pieces of evidence, or when a
verification settles it. Every case records `stop_reason`.

**Explainability.** Every evidence item names the query that produced it. Every
action cites its rule id. Claude writes the summary and the SAR narrative from
the assembled evidence only, and falls back to deterministic templates if the
API is unavailable, so the pipeline can never be blocked by a model call.

---

## What we would improve with more time

**The runtime read path should go through GSQL.** This is the honest weak spot.
The queries are written, installed and compiled on Savanna, and the schema, the
load, the ring algorithm, the policy vectors and the case writes all go through
TigerGraph. But the benchmark's evidence reads come from a local projection of
the same data. That happened for a mundane reason: Docker failed on the dev
machine, so we built a CSV-backed evidence layer to make progress with no
database at all, and once Savanna was up the deadline was closer than the
refactor was safe. We cross-checked the two paths agree (`getAccountProfile` on
C08623 returns 1,140 transactions from both), but agreeing is not the same as
using it.

**TigerGraph MCP is not wired in.** Our orchestrator is a deterministic state
machine that calls typed functions; the LLM never selects tools, which is
exactly what makes the permission gate verifiable. MCP, which exists to expose
tools for a model to choose between, had no natural insertion point in that
design. That is an explanation, not a defence: the brief lists it as required
and we should have resolved the tension early rather than late.

**More graph algorithms.** Connected components found the rings. Community
detection with edge weights and a temporal window would likely separate the
dense core we currently report as one blob.

**Real embeddings.** Ours are hashed bag-of-words computed locally, which is
honest and free and works at 29 chunks, but a proper embedding model would
retrieve better across a larger policy corpus.

---

## What we learned

The thing that surprised us most was how much of the work was **reading the data
rather than writing the agent**. Three of our biggest quality jumps came from
measurement, not from prompting: recovering the `card_id` rule, discovering that
device profiles are types rather than fingerprints, and calibrating signals
against their base rates. The agent framework was the easy part.

The second lesson: our planning documents were written before anyone had opened
the dataset, and several of their assumptions were simply wrong. They specified
an `IPAddress` node (the data has no IP column), email as an identity link (it
is domain-level only, 60 distinct values), and invented nine action names where
the policy defines fourteen exact ones. We reconciled every document against the
README and left the correction notes in place rather than quietly rewriting
history, because the corrections are the interesting part.

And the last: cost discipline is a design decision. The LLM writes prose only,
responses are cached to disk on a prompt hash, and the SAR narrative is
generated only for cases that file one. A full twenty-case run costs **$0.07**,
and re-running it costs nothing.
