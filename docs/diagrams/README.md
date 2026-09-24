# Architecture diagrams

Each `.mmd` file holds one Mermaid diagram with no markdown fence, so the whole
file can be pasted straight into <https://mermaid.live> and rendered.

The `.png` next to it is that diagram already rendered at 2x on a transparent
background, ready to drop into the blog post or a slide.

| File | What it shows | Use it for |
|---|---|---|
| `01-system-overview` | ingestion, the graph, both transports, the agent, the surfaces | blog header, the architecture slide |
| `02-investigation-flow` | the eight states, the uncertainty loop, the permission gate | explaining how a case progresses |
| `03-graph-data-model` | 9 vertex types and their edges | the "how TigerGraph is used" section |
| `04-where-the-llm-sits` | deterministic code vs the model's job | the single strongest image |
| `05-graphrag` | why retrieval is graph-grounded, not keyword-driven | the GraphRAG section |
| `06-deployment` | the read-only and fully-live hosting shapes | deployment notes |

Re-render after an edit:

```
npx @mermaid-js/mermaid-cli -i docs/diagrams/01-system-overview.mmd \
  -o docs/diagrams/01-system-overview.png -s 2 -b transparent
```

If mermaid.live reports "No diagram type detected", the markdown fence
(```` ```mermaid ````) was pasted along with the code. Paste the file contents
only.
