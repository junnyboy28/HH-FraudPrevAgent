# Loading the HHGOA dataset into TigerGraph

Two steps, always in this order:

1. **Prepare** (on your machine). `prepare_data.ts` reads `data/HHGOA_IEEE/` and
   writes one normalized CSV per vertex and edge type into
   `prepared/<mode>/`. TigerGraph never parses the raw dataset.
2. **Load** (on the server). `load_jobs.gsql` installs one loading job;
   `run_sample.gsql` and `run_full.gsql` run it against the prepared files.

```
npm run prep:sample     # first 1,000 transactions, ~13s
npm run prep:full       # all 590,742 transactions, ~45s, writes ~224 MB
```

Both modes end with a `card_id check` line. It must report a full match before
you load anything. See "How card_id is derived" below.

## Install the schema

```
gsql graph/schema.gsql
```

This creates the vertex and edge types, then the graph. The graph is named
`FraudGraph`; keep `TIGERGRAPH_GRAPH_NAME` in `.env` in sync with it. Re-running
against an instance that already has the schema fails on the first `CREATE`, so
start from a clean instance or drop the graph first (`DROP GRAPH FraudGraph`).

## Install the loading job

```
gsql -g FraudGraph graph/load/load_jobs.gsql
```

The job declares its filenames without paths and takes them at run time, so one
job definition serves both the sample and the full load. Re-installing over an
existing job fails; `DROP JOB load_fraud_graph` first.

## Start a database: Community Edition in Docker

```
docker pull tigergraph/tigergraph:latest

docker run -d \
  -p 14022:22 -p 9000:9000 -p 14240:14240 \
  --name tigergraph \
  --ulimit nofile=1000000:1000000 \
  -v tg-data:/home/tigergraph \
  -t tigergraph/tigergraph:latest

docker exec -it tigergraph gadmin start all
```

GraphStudio is then at http://localhost:14240, default login `tigergraph` /
`tigergraph`. The image is about 4 GB and TigerGraph recommends 8 cores and
24 GB of RAM; it runs on 16 GB, but expect the full load to be slow and close
anything memory-hungry first.

Run any of the GSQL below with `docker exec -i tigergraph gsql ...`, or open a
shell in the container with `docker exec -it tigergraph bash`.

## Run the load: Community Edition

The GSQL loader reads paths **on the database server**, not on your laptop. With
Community Edition in Docker, copy the prepared folder into the container first:

```
docker cp graph/load/prepared/sample <container>:/home/tigergraph/hhgoa/sample
gsql -g FraudGraph graph/load/run_sample.gsql
```

and the same with `full` / `run_full.gsql` for the whole dataset. Both run
scripts expect the files under `/home/tigergraph/hhgoa/<mode>/`. If you put them
elsewhere, edit the paths at the top of the run script, or pass your own with
`RUN LOADING JOB load_fraud_graph USING f_accounts="...", ...`.

## Run the load: Savanna

Savanna has no server path you can copy files to, so `run_sample.gsql` and
`run_full.gsql` do not apply as written. The best option is REST: the loading
job accepts file content posted to it, one request per file variable.

```
curl -X POST --data-binary @prepared/full/accounts.csv \
  -u "$TIGERGRAPH_USER:$TIGERGRAPH_PASSWORD" \
  "https://$TIGERGRAPH_HOST/restpp/ddl/FraudGraph?tag=load_fraud_graph&filename=f_accounts"
```

`tag` is the loading job name and `filename` is the `DEFINE FILENAME` variable
it feeds, so the same job definition in `load_jobs.gsql` works unchanged. Repeat
for all 21 file variables; a file variable takes one request, so they cannot be
batched. `scripts/load-via-rest.ts` wraps this (added in the load phase).

Two alternatives if REST is inconvenient:

- **UI upload.** Workspace, then Load Data, then upload the files from
  `prepared/full/` (largest is `transactions.csv` at 132 MB, well under the 2 GB
  per-file limit) and map each file's columns onto the matching vertex or edge
  type. Column headers in the prepared files match the schema attribute names
  one to one, so Quick Map does most of it.
- **Cloud storage.** Put `prepared/full/` in S3 or GCS and point a loading job at
  those paths instead. The `LOAD` statements in `load_jobs.gsql` are unchanged;
  only the `DEFINE FILENAME` values differ.

Stop the workspace when you are not using it.

## Confirm the load worked

Counts are written to `prepared/<mode>/counts.json` at prep time. The graph
should match them exactly after a successful load.

```
USE GRAPH FraudGraph
SELECT count(*) FROM Account
SELECT count(*) FROM Transaction
```

or, for everything at once, run the built-in vertex and edge counters:

```
gsql -g FraudGraph "ls"
```

### Expected counts, full load

| Vertex | Count | | Edge | Count |
|---|---:|---|---|---:|
| Account | 13,553 | | OWNS | 14,317 |
| Card | 14,317 | | MADE | 590,742 |
| Transaction | 590,742 | | USED_DEVICE | 144,432 |
| Device | 9,706 | | PURCHASER_EMAIL | 496,262 |
| EmailDomain | 60 | | RECIPIENT_EMAIL | 137,453 |
| BillingRegion | 332 | | BILLED_IN | 525,003 |
| Case | 5,565 | | NEXT_TXN | 576,425 |
| FraudPattern | 7 | | SHARED_BY | 67,908 |
| PolicyDoc | 0 | | INVOLVES | 14,955 |
| | | | ON_CARD | 5,565 |
| | | | CONNECTED_TO | 92 |
| | | | INVESTIGATES | 5,565 |
| | | | MATCHES_PATTERN | 5,565 |
| | | | SIMILAR_TO | 0 |
| | | | CITES_POLICY | 0 |

Four of these are stated by the dataset README and are the strongest check:
590,742 transactions, 144,432 identity records, 5,565 closed cases, and 20 cases
in the case pack. Three more are arithmetic and should hold exactly:

- `MADE` equals `Transaction`: every transaction belongs to exactly one card.
- `NEXT_TXN` equals `Transaction` minus `Card` (576,425 = 590,742 - 14,317):
  each card's chain has one fewer link than it has transactions.
- `OWNS` equals `Card`: every card belongs to exactly one account.

`PolicyDoc`, `SIMILAR_TO` and `CITES_POLICY` are zero on purpose. Policy text is
loaded in the GraphRAG phase and `SIMILAR_TO` is written by the agent's
case-memory step.

### Expected counts, sample load

| Vertex | Count | | Edge | Count |
|---|---:|---|---|---:|
| Account | 277 | | OWNS | 277 |
| Card | 277 | | MADE | 1,000 |
| Transaction | 1,000 | | USED_DEVICE | 193 |
| Device | 108 | | PURCHASER_EMAIL | 755 |
| EmailDomain | 26 | | RECIPIENT_EMAIL | 130 |
| BillingRegion | 53 | | BILLED_IN | 930 |
| Case | 17 | | NEXT_TXN | 723 |
| FraudPattern | 7 | | SHARED_BY | 161 |
| | | | INVOLVES | 27 |
| | | | ON_CARD | 17 |
| | | | INVESTIGATES | 17 |
| | | | MATCHES_PATTERN | 17 |

The sample keeps only the 17 closed cases that touch one of its 1,000
transactions; the other 5,548 are dropped rather than loaded with edges pointing
at transactions that are not in the graph. **The sample cannot answer the case
pack**: all 20 exam cases are from November and December, and the first 1,000
transactions are from July 2. Use the sample for query development and the full
load for anything that produces an answer file.

## How card_id is derived

`transactions.csv` has no `card_id` column, but the case pack and the closed
cases both reference cards as `C01234-K1`. The rule, recovered from the data:

> Within one customer, a card is identified by its **`card6`** value (`credit`,
> `debit`, or empty where the dataset omits it). Sort that customer's distinct
> `card6` values ascending as strings, with the empty value first. A card's
> `-KN` suffix is its 1-based position in that order.

This is not a guess. It reproduces:

- **14,955 of 14,955** transaction-to-card labels in `closed_cases_history.csv`
- **20 of 20** flagged transactions in `case_pack.csv`

`prepare_data.ts` re-runs both checks on every prep and refuses to finish if
either disagrees, so a wrong card map can never reach the graph silently.

Two consequences worth knowing:

- `card1` is constant per customer (the dataset derives `customer_id` from it),
  and `card4` (the network) is constant per card. `card2`, `card3` and `card5`
  vary within a single card, so they live on `Transaction`, not on `Card`.
- The `-KN` index depends on the customer's **whole** history, so prep pass 1
  always reads the entire file even in sample mode. That is why the sample prep
  takes 13 seconds rather than under one.

## Where the schema departs from architecture.md section 3.1

The dataset does not contain everything the architecture assumed. Each of these
is a deliberate change, not an oversight:

| architecture.md | Here | Why |
|---|---|---|
| `IPAddress` node, `FROM_IP` edge | **Dropped** | There is no IP column anywhere in the dataset. `id_23` is a proxy flag and `id_01`-`id_11` include an IP-domain *rating*, but no address. A vertex that can never be populated would make its queries return empty rather than error. |
| `Email` node, `(Account)-[:USES_EMAIL]->(Email)` | `EmailDomain`, `(Transaction)-[:PURCHASER_EMAIL\|RECIPIENT_EMAIL]->(EmailDomain)` | The dataset has `P_emaildomain` / `R_emaildomain`, which are domains (`gmail.com`), not addresses. Two accounts sharing `gmail.com` are not linked in any meaningful sense, so treating this as a shared identifier the way section 3.1 intends would manufacture false connections. There are only 60 distinct domains. |
| `Address` node, `(Account)-[:USES_ADDRESS]->(Address)` | `BillingRegion`, `(Transaction)-[:BILLED_IN]->(BillingRegion)` | `addr1` is an anonymized region code, not a street address, and it is a property of the transaction rather than the account. Region *is* a real linking entity: pattern 4 and policy rule R6 both turn on it. |
| `Account` | `Account` (kept), holding `customer_id` | The dataset calls this a customer. The architecture name is kept; only the meaning of the id is documented here. |
| `(Account)-[:MADE]->(Transaction)` | `(Card)-[:MADE]->(Transaction)` | The dataset identifies a card per transaction and every pattern query works per card. Accounts still reach transactions through `OWNS`. |
| `Device` | `Device`, keyed `"DeviceInfo \| OS \| browser \| screen"` | That exact string is what the answer format requires in `connected_device_profiles`, so the vertex key and the deliverable are the same value. |
| `Case` | `Case` with a `source` attribute | Covers both the bank's 5,565 closed cases and the agent's own, so case-memory retrieval traverses one type. |
| (not in 3.1) | `NEXT_TXN` | Added. Card-testing and velocity patterns are sequence questions; a per-card chain makes them a traversal instead of a scan. |

`agent.md` section 4 now carries the five pattern names and ids from the dataset
README.

## Columns not loaded

Of the 397 columns in `transactions.csv`, the graph takes the interpretable ones
and leaves out three unnamed engineered groups:

- **`V1` to `V339`** (Vesta's engineered features). 339 unnamed columns on
  590,742 rows, none of which any planned query reads.
- **`C1` to `C14`** (counts) and **`D1` to `D15`** (day deltas). Unnamed
  individually. They are loadable, but every one of them would need an invented
  "missing" sentinel, and the signals they stand in for (velocity, time since
  last use) are computable exactly from `ts` and `NEXT_TXN`.
- **`id_01` to `id_11`** on the identity record (encoded ratings). These take
  negative values, so there is no safe numeric sentinel for a blank.

`M1` to `M9` **are** loaded: the match flags are named in the README and pattern
5 (account takeover) turns on match-flag anomalies. `id_12` to `id_38` are
loaded as attributes of the `USED_DEVICE` edge, including `id_15` (device New or
Found, the pattern 3 signal), `id_23` (proxy) and `id_34` (match status).

To add a group back: extend the `Transaction` vertex in `schema.gsql`, add the
columns to the `wTxn` writer in `prepare_data.ts`, and add them to the
`f_transactions` `LOAD` statement. Decide on a missing-value convention first,
and write it down next to `num()` in the prep script, which currently only
applies `-1` to `dist1` and `dist2` (distances, never negative in the source).

## Prepared files

`prepared/` is gitignored; it is regenerated from the dataset in under a minute.

| File | Loads into |
|---|---|
| `accounts.csv` | `Account` |
| `cards.csv` | `Card` |
| `transactions.csv` | `Transaction` |
| `devices.csv` | `Device` |
| `email_domains.csv` | `EmailDomain` |
| `billing_regions.csv` | `BillingRegion` |
| `cases.csv` | `Case` (closed history only) |
| `fraud_patterns.csv` | `FraudPattern` |
| `e_owns.csv`, `e_made.csv`, `e_used_device.csv`, `e_purchaser_email.csv`, `e_recipient_email.csv`, `e_billed_in.csv`, `e_next_txn.csv`, `e_shared_by.csv`, `e_involves.csv`, `e_on_card.csv`, `e_connected_to.csv`, `e_investigates.csv`, `e_matches_pattern.csv` | the edge of the same name |
| `counts.json` | not loaded; the expected counts for this run |

Every file is comma separated, has a header row whose names match the schema
attributes, and quotes every field with double quotes. Carriage returns and
newlines inside text fields are flattened to spaces, because the loader splits
records on newline.
