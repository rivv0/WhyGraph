Viewed README.md:1-56

Your draft is fundamentally **excellent** and extremely well-written! It explains the value proposition perfectly.

The **ONLY** incorrect parts are the terminal commands you wrote. You mocked out commands like `graphengine analyze` and `graphengine ask`, but in reality, all of our commands are run through `npm run dev`. 

I fixed the commands and the GitHub clone URL for you. Here is the **100% correct version** you should paste into your `README.md`:

```markdown
# GraphEngine

> **"Why was this built this way?"**
> Every developer asks this. GraphEngine answers it.

Point GraphEngine at any GitHub repository. It reads through commits, pull requests, and discussions — and builds a **queryable knowledge graph of every engineering decision ever made.**

No cloning. Just answers.

🔗 **[Try it live →](https://why-graph-node.onrender.com)**

---

## What it does

Most codebases are graveyards of undocumented decisions. Why was this architecture chosen? Why did they switch libraries? Why does this weird workaround exist?

GraphEngine reconstructs the **reasoning behind your codebase** by mining the conversations that happened around it — and lets you query that reasoning in plain English.

```bash
# Analyze any public GitHub repo
npm run dev ingest facebook react
npm run dev normalize facebook react
npm run dev extract facebook react

# Ask questions about specific components
npm run dev why facebook react fiber
npm run dev why facebook react classComponent
npm run dev why facebook react concurrentMode
```

---

## Demo

| Query | Answer |
|-------|--------|
| `why was fiber introduced?` | Extracted from 3 PRs, 12 commits — with citations |
| `what changed in v18?` | Timeline of decisions leading to React 18 |
| `why is reconciliation designed this way?` | Grounded answer from actual PR discussions |

---

## How it works

```
GitHub Repo URL
      ↓
  Pull Requests + Commits + Issues (via GitHub API — no cloning needed)
      ↓
  Normalization → Decision Extraction (LLM-powered)
      ↓
  Knowledge Graph (relationships, timelines, decay modeling)
      ↓
  Why-Query Engine → Natural language answers with citations
```

**No raw source code is ever downloaded.** GraphEngine works entirely over the GitHub API using just a token.

---

## Architecture

| Layer | What it does |
|-------|-------------|
| **Ingestion** | Captures GitHub events as immutable records |
| **Normalization** | Unified event format across PRs, commits, issues |
| **Decision Extraction** | LLM identifies decisions from raw discussions |
| **Knowledge Graph** | Maps relationships between decisions and outcomes |
| **Decision Timeline** | Tracks how decisions evolved over time |
| **Knowledge Freshness** | Decay + reinforcement modeling for stale decisions |
| **Why-Query Engine** | Natural language queries over the decision graph |
| **Explainability** | Every answer is grounded with source citations |

---

## Getting Started

**Web interface (no install needed):**
👉 [https://why-graph-node.onrender.com](https://why-graph-node.onrender.com)

**CLI:**

```bash
# Clone and install
git clone https://github.com/rivv0/WhyGraph.git
cd WhyGraph
npm install

# Add your GitHub token and LLM Provider Key (Groq or OpenAI)
echo "GITHUB_TOKEN=your_token_here" > .env
echo "GROQ_API_KEY=your_key_here" >> .env

# Run
npm run dev              # Show all CLI commands
npm run web              # Start Web interface
npm run dev why <owner> <repo> <comp>  # Query from terminal
```

---

## Why this is hard

- GitHub discussions are **unstructured and noisy** — extracting actual decisions requires understanding context, not just keywords
- Decisions aren't atomic events — they **evolve across dozens of PRs** over months
- Answers need to be **grounded** — hallucinated explanations are worse than no explanation
- Knowledge goes **stale** — a decision made in 2019 may have been reversed in 2022

GraphEngine handles all of this.

---

## Tech Stack

`Node.js` `SQLite` `JavaScript` `GitHub API` `LLM (decision extraction)` `Vector embeddings` `Canvas API`

---

## Built by

**rivva <3**
---

*GraphEngine is what happens when you treat a GitHub repository not as code — but as a record of human decisions.*
```