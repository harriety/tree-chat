# Tree-Chat 🌳

Tree-Chat is an **LLM-first chat workspace** that organizes conversations as a **tree of threaded nodes**, instead of a single linear chat stream.

Each node represents a **self-contained conversation context**, allowing users to branch, explore, revisit, and compare multiple reasoning paths in parallel — without losing context.

Tree-Chat is designed for **non-linear thinkers**, deep exploration, and AI-assisted reasoning workflows where ideas naturally diverge and evolve.

---

## Why Tree-Chat?

Traditional chat interfaces force all thoughts into a single chronological timeline.

This model works for simple Q&A, but breaks down when ideas diverge, assumptions need to be revisited, or multiple alternatives must be explored in parallel.

Tree-Chat mirrors how humans actually think:

* Ideas branch naturally
* Early assumptions can be revisited and refined
* Multiple hypotheses can be explored side by side
* Context is preserved per branch, not overwritten

In Tree-Chat, every node is both:

* an **independent chat thread**, and
* a **connected part of a larger reasoning tree**

---

## Key Features

* Tree-structured, threaded conversations
* Branching and collapsing nodes
* Delete an entire subtree with one-step undo
* LLM-powered node auto-naming and summarization
* Streaming responses with cancel and retry support
* Tree View and Mindmap View for navigation and visualization
* Local-first persistence with automatic backups
* Import and export conversations as portable JSON

---

## How to Use

### Local Setup

#### Requirements

* Node.js 18+
* npm

#### Install dependencies

```bash
npm install
```

#### Environment variables

Copy the example environment file:

```bash
cp env.example .env.local
```

Edit `.env.local` and add your API keys as needed:

```env
VITE_OPENAI_API_KEY=your_api_key
VITE_GEMINI_API_KEY=your_api_key
```

You can configure a default LLM provider via environment variables or switch providers directly in the UI.

#### Run locally

```bash
npm run dev
```

Then open the local URL shown in the terminal (usually `http://localhost:5173`).

All conversations are saved automatically in the browser.

---

## Project Status

Tree-Chat is an actively evolving prototype focused on:

* structured reasoning
* exploratory AI workflows
* scalable conversation models beyond linear chat

Contributions, feedback, and ideas are welcome.

---

## Built With

* React + TypeScript + Vite
* React Flow + dagre for visualization
* Provider-agnostic LLM adapter
* Immutable tree-based state architecture
