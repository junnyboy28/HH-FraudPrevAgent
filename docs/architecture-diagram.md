# Architecture diagrams

Mermaid source. Paste any block into <https://mermaid.live> to render and export
as PNG or SVG. GitHub, Notion and Obsidian render these inline as-is.

---

## 1. System overview

The one to use in the blog post and the slide.

```mermaid
flowchart TB
    subgraph Ingest["Ingestion, one time"]
        RAW["HHGOA_IEEE dataset<br/>590,742 txns · 144,432 identity rows<br/>5,565 closed cases · 20 exam cases"]
        PREP["prepare_data.ts<br/>derives card_id · builds NEXT_TXN<br/>materialises SHARED_BY"]
        LOADER["load-tigergraph.ts<br/>chunked REST into a GSQL loading job"]
        POLICY["ingest-policy-docs.ts<br/>29 policy chunks + 256-dim vectors"]
        RAW --> PREP --> LOADER
        RAW --> POLICY
    end

    subgraph TG["TigerGraph Savanna"]
        GRAPH[("Knowledge graph<br/>9 vertex types · 15 edge types")]
        VEC[("PolicyDoc vertices<br/>with embeddings")]
        QUERIES["7 compiled GSQL queries<br/>incl. findDeviceRings<br/>connected components"]
    end

    LOADER --> GRAPH
    POLICY --> VEC

    subgraph Access["How the agent reaches the graph"]
        MCP["TigerGraph MCP server<br/>69 tools, stdio"]
        REST["REST client"]
    end

    QUERIES --- GRAPH
    MCP --> QUERIES
    REST --> QUERIES

    subgraph Agent["The agent"]
        EV["EvidenceSource<br/>one interface, three transports"]
        PAT["patterns.ts<br/>5 documented + device rings"]
        RAG["PolicyStore<br/>GraphRAG retrieval"]
        POL["policy-engine.ts<br/>R1..R10 · 14 actions · auto/L1/L2"]
        ORCH["CaseOrchestrator<br/>8-state machine"]
        LLM["Claude<br/>prose only"]
        MEM["case writer"]
    end

    MCP --> EV
    REST --> EV
    VEC --> RAG
    EV --> ORCH
    PAT --> ORCH
    RAG --> ORCH
    ORCH --> POL
    ORCH --> LLM
    ORCH --> MEM
    MEM --> GRAPH

    subgraph Out["Surfaces"]
        API["src/api/server.ts :4000"]
        UI["Next.js UI :3000<br/>queue · case view · new investigation"]
        FILES["cases/*.json<br/>20 answer files"]
        VAL["validate_answers.ts"]
    end

    ORCH --> API --> UI
    ORCH --> FILES --> VAL

    style TG fill:#0d2b45,stroke:#3d6b9e,color:#fff
    style Agent fill:#1a2332,stroke:#5a7a9e,color:#fff
    style LLM fill:#3d2b45,stroke:#9e6bbe,color:#fff
    style POL fill:#2b3d2b,stroke:#6b9e6b,color:#fff
```

---

## 2. The investigation flow

The eight steps, with the uncertainty loop and the permission gate.

```mermaid
flowchart TD
    T["TRIGGER<br/>risk score · customer report · analyst request"]
    INV["INVESTIGATING<br/>neighbourhood · timeline · profile<br/>shared devices · linked fraud · similar cases"]
    GATH["EVIDENCE_GATHERED<br/>pattern detection + GraphRAG policy retrieval"]
    ASSESS{"ASSESSING<br/>fraud probability<br/>verdict · exposure"}
    MORE["NEEDS_MORE_EVIDENCE<br/>ask the customer<br/>simulate the reply from the evidence<br/>record the assumption"]
    ACT["ACTION_SELECTED<br/>policy engine picks actions"]
    GATE{"Permission gate<br/>resolve the route"}
    AUTO["auto<br/>agent executes"]
    HUMAN["L1 or L2<br/>queued, awaiting a human"]
    EXP["EXPLAINED<br/>Claude writes summary + SAR narrative"]
    MEM["MEMORY_UPDATED<br/>FraudCase vertex written to the graph"]
    DONE["cases/&lt;case_id&gt;.json"]

    T --> INV --> GATH --> ASSESS
    ASSESS -->|"single weak signal below 0.70<br/>R1 forbids blocking"| MORE
    MORE -->|re-assess| GATH
    ASSESS -->|"enough evidence<br/>policy section 6"| ACT
    ACT --> GATE
    GATE -->|"BLOCK_CARD at or below $2,500"| HUMAN
    GATE -->|"BLOCK_CARD above $2,500"| HUMAN
    GATE --> AUTO
    AUTO --> EXP
    HUMAN --> EXP
    EXP --> MEM --> DONE

    style ASSESS fill:#3d3320,stroke:#9e8b4a,color:#fff
    style GATE fill:#3d2020,stroke:#9e4a4a,color:#fff
    style MORE fill:#20303d,stroke:#4a7a9e,color:#fff
    style MEM fill:#0d2b45,stroke:#3d6b9e,color:#fff
```

---

## 3. The graph data model

```mermaid
erDiagram
    Customer ||--o{ PaymentCard : OWNS
    PaymentCard ||--o{ Transaction : MADE
    Transaction }o--|| DeviceProfile : USED_DEVICE
    Transaction }o--|| BillingRegion : BILLED_IN
    Transaction }o--|| EmailDomain : PURCHASER_EMAIL
    Transaction ||--o| Transaction : NEXT_TXN
    DeviceProfile ||--o{ Customer : SHARED_BY
    FraudCase ||--o{ Transaction : INVOLVES
    FraudCase }o--|| PaymentCard : ON_CARD
    FraudCase }o--|| Customer : INVESTIGATES
    FraudCase }o--|| FraudPattern : MATCHES_PATTERN
    FraudCase ||--o{ FraudCase : SIMILAR_TO
    FraudCase }o--o{ PolicyDoc : CITES_POLICY

    Customer {
        string account_id PK
        int n_cards
        int n_transactions
    }
    PaymentCard {
        string card_id PK
        string card_type
        string network
    }
    Transaction {
        string txn_id PK
        double amount
        string channel
        double risk_score
        datetime ts
    }
    DeviceProfile {
        string device_profile PK
        int n_cards
    }
    FraudCase {
        string case_id PK
        string source
        string verdict
        double exposure_usd
    }
    PolicyDoc {
        string chunk_id PK
        list embedding
        string text
    }
```

`SHARED_BY` is the edge that earns its keep. "Which other cardholders used this
device" is one hop, and it is how the HHG-014 ring surfaces.

---

## 4. Where the LLM sits, and where it does not

The point of the whole design, in one picture.

```mermaid
flowchart LR
    subgraph Deterministic["Deterministic code, auditable"]
        D1["pattern detection"]
        D2["fraud probability"]
        D3["action selection<br/>R1..R10"]
        D4["approval routing<br/>auto / L1 / L2"]
        D5["stopping rule"]
    end

    subgraph Model["Claude, prose only"]
        L1["case summary"]
        L2["SAR narrative"]
    end

    EV["Evidence from the graph"] --> Deterministic
    Deterministic --> Model
    Model --> OUT["answer file"]
    Deterministic --> OUT

    NOTE["The model cannot invent an action,<br/>downgrade an L2 to auto,<br/>or skip the gate"]
    Model -.-> NOTE

    style Deterministic fill:#1f3320,stroke:#5a9e5a,color:#fff
    style Model fill:#3d2b45,stroke:#9e6bbe,color:#fff
    style NOTE fill:#332020,stroke:#9e5a5a,color:#fff
```

---

## 5. GraphRAG, in one picture

Why retrieval here is graph-grounded rather than keyword-driven.

```mermaid
flowchart LR
    Q["Flagged transaction"]
    G["Graph queries<br/>neighbourhood · timeline · profile<br/>shared devices · prior cases"]
    E["Assembled evidence<br/>what was actually found"]
    EMB["embed the evidence"]
    V[("PolicyDoc vectors<br/>in TigerGraph<br/>R1..R10 · 5 patterns · regulatory")]
    R["Top-k policy chunks"]
    B["Evidence Context Bundle<br/>graph evidence + policy text"]
    C["Claude"]

    Q --> G --> E --> EMB --> V --> R --> B
    E --> B
    B --> C

    style V fill:#0d2b45,stroke:#3d6b9e,color:#fff
    style C fill:#3d2b45,stroke:#9e6bbe,color:#fff
```

The query is the evidence, not a keyword. So a case showing a disputed charge on
a cardholder's own recurring pattern retrieves rule R7, and a case showing one
device across many cardholders retrieves R6 and R9.

---

## 6. Deployment

```mermaid
flowchart TB
    subgraph Cloud["TigerGraph Savanna, already hosted"]
        TGC[("FraudGraph<br/>590,742 transactions")]
    end

    subgraph Option1["Option A: read-only demo"]
        V["Vercel<br/>root directory: ui/"]
        VD["ui/data/<br/>20 case files vendored at build"]
        V --- VD
    end

    subgraph Option2["Option B: fully live"]
        R["Render / Railway / Fly<br/>one container"]
        RB["agent backend :4000<br/>+ dataset"]
        RU["Next.js UI :3000"]
        R --- RB
        R --- RU
    end

    TGC -.->|"case writes, MCP, GSQL"| RB
    U1["Visitor"] --> V
    U2["Visitor"] --> RU

    style Cloud fill:#0d2b45,stroke:#3d6b9e,color:#fff
    style Option1 fill:#1f3320,stroke:#5a9e5a,color:#fff
    style Option2 fill:#332b20,stroke:#9e8b4a,color:#fff
```
