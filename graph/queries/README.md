# GSQL queries

Six retrieval queries. Each file starts with a comment saying which
investigation step or fraud pattern it supports.

| Query | Returns | Used in |
|---|---|---|
| `getEntityNeighborhood(txn_id)` | The flagged transaction plus its card, cardholder, sibling cards, device, region, email domain, device-linked accounts, and any closed case already involving it | `INVESTIGATING`, first call of every case |
| `getCardTimeline(card_id)` | Every transaction on the card in time order, with device and identity signals | `EVIDENCE_GATHERED`, the backbone of pattern detection |
| `getAccountProfile(account_id)` | The cardholder's baseline: regions, channels, product codes, email domains, devices, amount range | `INVESTIGATING`, the "does not fit their history" comparison |
| `findSharedDevicesAcrossAccounts(account_id)` | Device profiles this account shares with other accounts, and who those accounts are | `EVIDENCE_GATHERED`, the R6 shared-origin signal |
| `findLinkedFraudHistory(account_id)` | Prior confirmed-fraud closed cases touching this account directly, or via a shared device | `INVESTIGATING` |
| `findSimilarClosedCases(account_id, pattern, region)` | Closed cases scored by shared device, same pattern, same region | `INVESTIGATING`, fills `similar_prior_cases` |

## Why six retrieval queries and not eleven detection queries

`build_plan.md` phase 2 called for these plus one detection query per fraud
pattern. Pattern detection lives in TypeScript instead, reading the timeline and
profile these queries return. Three reasons:

1. The graph earns its place on **linkage**: "which other accounts used this
   device", "does this entity touch prior fraud", "which closed cases resemble
   this one". Those are the queries above, and they are hard or slow anywhere
   else.
2. The patterns themselves are mostly sequence and threshold logic. "Three
   authorizations under $5 within an hour, then something larger" is a window
   scan over an ordered list. That is straightforward and testable in TS, and
   awkward and much harder to debug in GSQL.
3. Time. Against a same-day deadline, a large body of untested GSQL is the
   riskiest thing in the build. Six queries can be validated quickly; eleven
   complex ones cannot.

The detection logic still cites the graph evidence it used, so the case file's
`evidence[].ref` names the query the claim came from.

## Schema facts worth knowing

- Sequence questions traverse `NEXT_TXN`, a per-card chain ordered by `ts` with
  `gap_seconds` on the edge. `getCardTimeline` returns the same ordering
  directly, which is usually easier to work with.
- "Same device across accounts" is the `SHARED_BY` edge (`Device -> Account`),
  materialized by the data load, with `n_transactions`, `first_seen`,
  `last_seen`. Its reverse is `SHARES_DEVICE`.
- `USED_DEVICE` carries that transaction's identity record, including `id_15`
  (device `New` or `Found` for the account, the pattern 3 signal), `id_23`
  (proxy) and `id_34` (match status).
- Channel is `Transaction.channel`: `in_person` (product code W, no identity
  record) or `online`.
- `Transaction.risk_score` is the bank's model score. An input, never a verdict.
- There is no IP address in the dataset, and email is domain-level only, so
  neither can carry a linkage query. See `graph/load/README.md`.

## Status

**Not yet run against a live instance.** These are written against the schema in
`graph/schema.gsql` and the syntax in TigerGraph's GSQL reference, but no
TigerGraph instance has been available in the build so far, so expect to fix
syntax on first install. Install them with:

```
gsql -g FraudGraph graph/queries/<name>.gsql
gsql -g FraudGraph "INSTALL QUERY <name>"
```
