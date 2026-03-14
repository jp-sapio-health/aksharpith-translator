# Aksharpith Translator — Technical Architecture

## Overview

A Next.js 15 web application that translates Gujarati religious/biographical text into English using a four-stage agentic pipeline powered by the Anthropic Claude API. The pipeline runs server-side and streams real-time progress events to the browser via Server-Sent Events (SSE).

---

## Repository

```
GitHub:  https://github.com/jp-sapio-health/aksharpith-translator
Vercel:  https://web-six-sable-1118tqf2jy.vercel.app
```

---

## Stack

| Layer       | Technology                        |
|-------------|-----------------------------------|
| Framework   | Next.js 15 (App Router)           |
| Language    | TypeScript 5                      |
| Styling     | Tailwind CSS 3 + inline styles    |
| AI SDK      | `@anthropic-ai/sdk` ^0.39         |
| Hosting     | Vercel (serverless + streaming)   |
| Runtime     | Node.js (default Next.js runtime) |
| Fonts       | Cormorant Garamond, Lora, JetBrains Mono (Google Fonts) |

---

## File Structure

```
web/
├── app/
│   ├── layout.tsx               # Root layout — font imports, metadata
│   ├── page.tsx                 # Main UI (client component, all state + SSE reader)
│   ├── globals.css              # Base styles, CSS variables, keyframe animations
│   └── api/
│       └── translate/
│           └── route.ts         # POST handler — runs the 4-agent pipeline, streams SSE
├── next.config.mjs              # Next.js config (no special overrides needed)
├── tailwind.config.ts           # Theme: ink/gold/cream/sage palette + custom fonts
├── tsconfig.json                # Strict TypeScript
├── vercel.json                  # maxDuration: 300s for /api/translate (Pro plan)
├── .env.local                   # ANTHROPIC_API_KEY (gitignored)
└── package.json
```

---

## Pipeline Architecture

```
Browser (page.tsx)
      │
      │  POST /api/translate
      │  { text: string, styleContext: string }
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Next.js API Route  (app/api/translate/route.ts)        │
│                                                         │
│  ReadableStream ──► text/event-stream ──► Browser       │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  01. CHUNKER          claude-sonnet-4-6          │    │
│  │                                                 │    │
│  │  Input:  raw Gujarati text (any length)         │    │
│  │  Output: string[]  — ≤500-word chunks,          │    │
│  │          split only at paragraph boundaries     │    │
│  │  Emits:  {stage:'chunker', status:'running'}    │    │
│  │          {stage:'chunker', status:'done',       │    │
│  │           count:N, chunks:[...]}                │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         │ chunks[]                       │
│                         ▼                               │
│  ┌─────────────────────────────────────────────────┐    │
│  │  02. TRANSLATOR       claude-opus-4-6            │    │
│  │                                                 │    │
│  │  Input:  one chunk + full styleContext           │    │
│  │          (injected fresh for every chunk)        │    │
│  │  Output: English translation string             │    │
│  │  Loop:   sequential, one chunk at a time        │    │
│  │  Emits:  {stage:'translator', status:'progress',│    │
│  │           current, total, index, translation}   │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         │ translations[]                 │
│                         ▼                               │
│  ┌─────────────────────────────────────────────────┐    │
│  │  03. REVIEWER         claude-sonnet-4-6          │    │
│  │                                                 │    │
│  │  Input:  original Gujarati chunk +              │    │
│  │          English translation + styleContext     │    │
│  │  Output: { score: 0–100,                        │    │
│  │            issues: string[],                    │    │
│  │            revised: string }                    │    │
│  │  Loop:   sequential, one chunk at a time        │    │
│  │  Emits:  {stage:'reviewer', status:'progress',  │    │
│  │           chunk, index, score, issues, revised} │    │
│  │          {stage:'reviewer', status:'done',      │    │
│  │           avgScore}                             │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         │ revised[]                      │
│                         ▼                               │
│  ┌─────────────────────────────────────────────────┐    │
│  │  04. ASSEMBLER        claude-opus-4-6            │    │
│  │                                                 │    │
│  │  Input:  all revised chunk translations         │    │
│  │          concatenated                           │    │
│  │  Output: single coherent English document       │    │
│  │  Emits:  {stage:'assembler', status:'done',     │    │
│  │           output: string}                       │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## SSE Event Schema

All events are newline-delimited `data:` lines (standard SSE format).

```typescript
// Chunker
{ stage: 'chunker', status: 'running' }
{ stage: 'chunker', status: 'done', count: number, chunks: string[] }

// Translator
{ stage: 'translator', status: 'running' }
{ stage: 'translator', status: 'progress', current: number, total: number, index: number, translation: string }
{ stage: 'translator', status: 'done' }

// Reviewer
{ stage: 'reviewer', status: 'running' }
{ stage: 'reviewer', status: 'progress', chunk: number, index: number, score: number, issues: string[], revised: string }
{ stage: 'reviewer', status: 'done', avgScore: number }

// Assembler
{ stage: 'assembler', status: 'running' }
{ stage: 'assembler', status: 'done', output: string }

// Error (any stage)
{ error: string }
```

---

## Model Allocation

| Agent      | Model                | Rationale                                              |
|------------|----------------------|--------------------------------------------------------|
| Chunker    | claude-sonnet-4-6    | Lightweight JSON task — no translation needed          |
| Translator | claude-opus-4-6      | Highest-stakes step — fidelity + style requires Opus   |
| Reviewer   | claude-sonnet-4-6    | Structured JSON output — Sonnet sufficient for review  |
| Assembler  | claude-opus-4-6      | Final editorial pass — quality warrants Opus           |

---

## Style Context Injection

The `styleContext` string (Aksharpith House Style Guide) is injected into **every** Translator and Reviewer prompt. This is the core architectural decision that solves the original problem: unlike a single stateful session (ChatGPT / NotebookLM), each chunk gets the full style rules re-injected, so context never degrades across a long document.

Default rules pre-loaded in the UI cover:
- British English (Oxford/Hart's Rules)
- Restrictive diacritics policy (macrons only in canonical verse)
- Mandatory glossary: `paramhansa`, `avatari Purush`, `Shriji Maharaj`, `bawa`, `Swami`
- Punctuation: curly quotes, spaced en dashes, Oxford comma
- Block-quote threshold (>40 words)
- Date format: `3 April 1781`

The user can edit these rules in the UI before running.

---

## Client State Machine (page.tsx)

```
idle
 │
 ├─► [Run clicked] → isRunning = true, reset all state
 │
 │   SSE stream open
 │   │
 │   ├─► chunker:running  → stages[0].status = 'running'
 │   ├─► chunker:done     → stages[0].status = 'done', chunks[] initialised
 │   │
 │   ├─► translator:progress (×N) → chunks[i].translation updated live
 │   ├─► translator:done
 │   │
 │   ├─► reviewer:progress (×N)  → chunks[i].{score, issues, revised} updated live
 │   ├─► reviewer:done           → avgScore set, shown in header
 │   │
 │   ├─► assembler:running
 │   └─► assembler:done  → output set, page scrolls to result
 │
 └─► isRunning = false
```

---

## Environment Variables

| Variable            | Required | Description                        |
|---------------------|----------|------------------------------------|
| `ANTHROPIC_API_KEY` | Yes      | Set in Vercel dashboard + .env.local |

---

## Deployment

```
Platform:  Vercel (serverless)
Build cmd: next build
Output:    .next/
Region:    Auto (US West PDX used on initial deploy)

Function timeout:
  vercel.json sets maxDuration: 300 for /api/translate
  → Requires Vercel Pro plan
  → Free Hobby plan: 60s limit (sufficient for ~2–3 chunks)
```

### Redeploy after code changes

```bash
cd web/
git add . && git commit -m "your message"
git push origin main   # Vercel auto-deploys on push
```

Or manually:
```bash
vercel --prod
```

---

## Known Constraints & Next Steps

| Constraint | Detail | Possible fix |
|---|---|---|
| Vercel 60s timeout (free tier) | Long documents (>4 chunks) may time out | Upgrade to Pro, or process chunks client-side in batches |
| Sequential chunk processing | Chunks translated one at a time | Parallelise with `Promise.all` (watch rate limits) |
| No file upload | Currently paste-only | Add `.docx` / `.txt` upload via `mammoth` or `formidable` |
| No persistence | Results lost on refresh | Add Supabase or Vercel KV to store sessions |
| Style guide is manual text | User must paste/edit rules | Add doc upload for the Aksharpith style PDF directly |
