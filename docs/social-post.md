# Social post drafts

Pick one, paste your blog or demo link where marked, and post. Tag
**@TigerGraphDB**.

---

## LinkedIn (longer, the safer default)

Spent the weekend building an agentic fraud investigation system on TigerGraph
for the Hacker House Goa hackathon, and the most interesting part wasn't the
agent. It was the data.

The task: 590,000 card transactions, no fraud label anywhere, and 20 benchmark
alerts to investigate. The agent has to work out what kind of fraud it is, how
far it goes, what to do about it, and when it has enough evidence to act.

Three things the dataset taught me:

1. The case files reference cards as C01234-K1, but the transaction file has no
card_id column at all. I had to recover the rule from the data. Two hypotheses
failed before one reproduced all 14,955 known labels exactly.

2. A "device profile" is not a device fingerprint. One profile in the data
covers 1,013 different cards. Treat that as identity and you invent fraud rings
out of everyone who owns the same laptop. The real signal turned out to be
specificity, not frequency: a specific handset build shared by 51 cardholders in
a month is a ring, a generic Windows + Chrome string shared by 842 is noise.

3. Calibrate every signal against its base rate. "New device on this account"
sounds damning. It's 42.8% of all records. People buy new phones.

The design decision I'd defend hardest: the LLM writes prose and nothing else.
Pattern detection, action selection and approval routing are deterministic code
reading the bank's policy. That's what makes "this action needs a fraud
manager's approval" something you can audit instead of something you hope the
prompt enforced.

Half the benchmark cases are legitimate, and the brief warns that an agent which
blocks everything scores badly. Mine blocks 5 of 20 and revises its
recommendation on 6 after asking for more evidence.

Full write-up: [BLOG LINK]
Demo: [DEMO LINK]
Code: https://github.com/junnyboy28/HH-FraudPrevAgent

@TigerGraphDB

---

## X / Twitter (thread)

**1/**
Built an agentic fraud investigation system on @TigerGraphDB this weekend.
590k transactions, no fraud label, 20 cases to solve.

The agent was the easy part. The data had opinions.

🧵

**2/**
The case files reference cards as C01234-K1.

The transaction file has no card_id column.

Had to recover the rule from the data itself. Two hypotheses failed (39%, then
93%) before one reproduced all 14,955 known labels exactly.

**3/**
Then: a "device profile" is not a fingerprint.

One profile in this dataset covers 1,013 different cards.

Treat it as identity and you invent fraud rings out of everyone who owns the
same laptop.

**4/**
The fix wasn't a frequency cutoff. That threw away the real ring.

It's specificity:
• a specific handset build on 51 cardholders in a month = ring
• "Windows | Chrome | 1920x1080" on 842 = noise

High count on a *specific* device IS the signal.

**5/**
Base rates matter more than intuition.

"New device on this account" sounds damning.
It's 42.8% of all records.

People buy new phones.

**6/**
Design decision I'd defend hardest: the LLM writes prose and nothing else.

Pattern detection, action selection, approval routing: deterministic code
reading the bank's policy.

That's what makes "needs a fraud manager's sign-off" auditable, not hoped for.

**7/**
Half the cases are legitimate. An agent that blocks everything scores badly.

Mine blocks 5 of 20, files 5 reports, and revises its recommendation on 6 cases
after asking the customer for more evidence.

Code: https://github.com/junnyboy28/HH-FraudPrevAgent
Write-up: [BLOG LINK]

---

## Short version (if you want one post, not a thread)

Built an agentic fraud investigation agent on @TigerGraphDB: 590k transactions,
no fraud label, 20 cases.

Biggest lesson: a "device profile" shared by 1,013 cards isn't a fingerprint,
it's a laptop model. The signal is specificity, not frequency.

The LLM writes prose. The policy engine makes the decisions, so the permission
model is auditable.

https://github.com/junnyboy28/HH-FraudPrevAgent
[BLOG LINK]

---

## Before posting

- Replace [BLOG LINK] and [DEMO LINK].
- Every number above is measured, not estimated: 14,955 labels, 1,013 cards on
  one profile, 842 on the Windows/Chrome profile, 42.8% new-device rate, 5 of 20
  blocked, 6 of 20 revised.
- Do not add a claim that the agent queries TigerGraph via MCP. It does not.
