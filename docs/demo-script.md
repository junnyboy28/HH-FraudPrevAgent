# Demo video script (3 to 5 minutes)

Two terminals and a browser. Start both processes before recording:

```
npm run dev            # agent backend on :4000, wait for "agent API on http://localhost:4000"
cd ui && npm run dev   # UI on :3000
```

Have these tabs open and pre-loaded so nothing spins during the take:
`localhost:3000`, `localhost:3000/case/HHG-014`, `localhost:3000/case/HHG-003`,
`localhost:3000/new`.

Total target: 4 minutes. Timings below are cumulative.

---

## 0:00 to 0:25 — The problem, in one breath

> "A fraud analyst gets an alert and spends the next half hour pulling
> transaction history, checking what device it came from, looking for other
> accounts on that device, digging out similar past cases, and reading the
> policy to see what they're allowed to do. This agent does that whole job on a
> TigerGraph knowledge graph, and shows its work."

On screen: the queue at `localhost:3000`.

Point at the header: 590,742 transactions. Point at the stat row: 9 legitimate,
6 uncertain, 5 fraud.

> "Twenty benchmark cases. Note the spread. About half are legitimate, and the
> dataset warns that an agent which blocks everything scores badly. Five cards
> blocked, not twenty."

---

## 0:25 to 1:35 — One case end to end (HHG-014)

Click into **HHG-014**.

> "This one came in as an analyst request: several cards this month from the
> same unusual device profile."

Point at the probability gauge.

> "0.90, fraud. The bar is marked at the policy's own thresholds: 0.15 to clear,
> 0.70 to act, 0.85 to stop investigating."

Scroll to the amber **undocumented pattern** box.

> "The agent classified this as `undocumented`, which the dataset scores
> specifically. One Galaxy S7 build used by 28 different cardholders inside a
> month, appearing as a new device on each account, behind an anonymous proxy.
> That fits none of the five documented patterns, because all five are defined
> from a single cardholder's point of view. This is one actor across many."

Scroll to **Evidence**.

> "Every claim carries the query that produced it. These come from the graph."

Point at a `policydoc:` ref.

> "And these came from GraphRAG. The policy is chunked into vertices in
> TigerGraph with embeddings, and the retrieval query is the graph evidence
> itself, so the policy that comes back is the policy that matches what was
> found."

---

## 1:35 to 2:25 — Uncertainty and the permission gate

Scroll to **Next best action**.

> "Left is what it recommended before asking for more evidence. Right is after.
> This contrast is the thing the brief weights most heavily: the recommendation
> is allowed to change, and it has to show that it did."

Point at the route badges.

> "Every action cites the policy rule that produced it, R1 through R10. And
> every action carries an approval route. `auto` the agent executes itself.
> `L1` needs a team lead, `L2` needs a fraud manager."

Point at `BLOCK_CARD` and its route.

> "The routing is conditional, not a flag. `BLOCK_CARD` is L1 at or below
> $2,500 exposure and L2 above it, resolved from the case."

Click **Approve** on the `FILE_REPORT` L2 action.

> "The agent recommends. A human decides. Until that record exists, the action
> does not execute, and that's enforced in the gate rather than in the prompt."

Then scroll to the **SAR** and let it sit on screen for three seconds.

> "And when the policy calls for it, a regulatory filing that stands on its own."

---

## 2:25 to 3:05 — Calibration: the case it does NOT block

Back to the queue, click **HHG-003**.

> "This one matters just as much. The customer disputed a $49 charge. That
> sounds like fraud."

Point at the probability and the actions.

> "But the graph says this cardholder has over a thousand transactions across
> 53 billing regions, and the disputed charge sits among four similar in-person
> purchases the same day. Policy rule R7 covers exactly this: a disputed charge
> that matches the cardholder's own pattern. Create a case, verify, warn. Do not
> block. Blocking a real customer on one signal is a policy breach, and the
> agent is built to know that."

---

## 3:05 to 3:50 — Live investigation from the graph

Go to **/new**.

> "It isn't limited to the twenty benchmark cases. I can start an investigation
> on anything in the graph."

Search a customer, pick a card, pick a transaction, pick a trigger.

> "Every input here is read from the dataset. Cardholder, then their cards, then
> that card's transactions. There's no free-text id field, and the backend
> rejects an id that isn't in the graph, so the agent can't be pointed at
> something that doesn't exist."

Click **Run investigation**.

> "Same orchestrator, same policy engine, same permission gate as the benchmark.
> Eight steps: trigger, investigate, gather, assess, gather more if the policy
> says so, act, explain, update memory."

When the case view loads, point at `graph: CASE-2016-…` in the header.

> "And the finished case is written back into TigerGraph as a Case vertex, so
> the next investigation can retrieve it. The memory isn't a log file, it's part
> of the graph."

---

## 3:50 to 4:15 — Close

> "Under the hood: the schema and the 590,000-row load are GSQL, the device ring
> you saw is connected components over the shared-device graph, the policy is
> retrieved from vectors stored in TigerGraph, and Claude writes the case
> summaries and the regulatory narratives from the retrieved evidence only.
> Pattern detection, action selection and approval routing stay deterministic,
> which is what makes the permission model something you can audit rather than
> hope for. Twenty answer files, all passing a validator against the dataset's
> answer format."

---

## If a take goes wrong

- The backend takes about ten seconds to load on first start. Wait for the
  ready line before recording.
- Savanna auto-stops. If the graph is asleep, the live investigation still runs
  (the policy store falls back to a local corpus) but the case write will fail.
  Wake the workspace first.
- `/new` on a card with few transactions gives a short, boring case. Pick a
  cardholder with a few hundred transactions for a better-looking result.

## Things not to claim on camera

- Do not say the agent reads its evidence through the GSQL queries at runtime.
  The queries are installed and compiled on Savanna, and the schema, the load,
  the ring algorithm and the case writes all go through TigerGraph, but the
  benchmark's read path uses a local projection of the same data.
- Do not claim TigerGraph MCP is used. It is not.
