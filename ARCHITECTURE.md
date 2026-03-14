# Aksharpith Translator — Technical Architecture

## Overview

A Next.js 15 web application that translates Gujarati religious/biographical text into publication-ready English using a five-stage agentic pipeline powered by the Anthropic Claude API. The pipeline runs server-side and streams real-time progress events to the browser via Server-Sent Events (SSE). Accepts paste, PDF, DOCX, or TXT input — including entire books via automatic chapter detection and sequential book-mode processing.

---

## Repository

```
GitHub:  https://github.com/jp-sapio-health/aksharpith-translator
Vercel:  https://web-six-sable-1118tqf2jy.vercel.app
```

---

## Stack

| Layer       | Technology                                          |
|-------------|-----------------------------------------------------|
| Framework   | Next.js 15 (App Router)                             |
| Language    | TypeScript 5                                        |
| Styling     | Inline React styles + CSS variables (no Tailwind dependency at runtime) |
| HTTP        | Node.js native `https` module (no SDK — bypasses Next.js fetch patching) |
| File parsing | `mammoth` (DOCX) · Claude PDF vision (PDF → Unicode) |
| Hosting     | Vercel (serverless, 300s Pro timeout)               |
| Runtime     | Node.js                                             |
| Fonts       | Cormorant Garamond + Karla (Google Fonts)           |

---

## File Structure

```
web/
├── app/
│   ├── layout.tsx                  # Root layout — font imports, metadata, viewport
│   ├── page.tsx                    # Main UI — all state, SSE reader, book-mode orchestrator
│   ├── globals.css                 # CSS variables (warm palette), keyframe animations
│   └── api/
│       ├── upload/
│       │   └── route.ts            # POST — accepts PDF/DOCX/TXT, returns extracted text + chapters
│       └── translate/
│           └── route.ts            # POST — runs 5-agent pipeline, streams SSE
├── next.config.mjs                 # serverExternalPackages: [@anthropic-ai/sdk, mammoth]
├── vercel.json                     # maxDuration: 300s for /api/translate
├── .env.local                      # ANTHROPIC_API_KEY (gitignored)
└── package.json                    # mammoth added; @anthropic-ai/sdk kept as dep but not used at runtime
```

---

## Gold Standard Context

Three authoritative documents are baked into the system prompts as immutable constants:

| Document | Role | How used |
|----------|------|----------|
| `Aksharpith House Rules - 1.pdf` | Master editorial + translation rules | Embedded in full in `TRANSLATOR_SYSTEM` and `REVIEWER_SYSTEM` |
| `Master Glossary - New - 06-11-25.pdf` | ~200 canonical theological term definitions | Key terms embedded in `KEY_GLOSSARY` constant |
| `Examples and Lessons from BAPS Translations.docx` | 79+ before/after correction examples | Critical corrections listed in `REVIEWER_SYSTEM` |

A fourth document (`GOLD STANDARD PROMPTS.docx`) provided the four prompt templates that shaped each agent's instructions:

| Prompt | Mapped to |
|--------|-----------|
| Prompt 1 — Context initialisation | CHUNKER_SYSTEM (structural setup) |
| Prompt 2 — "Trustee of tradition" mindset | TRANSLATOR_SYSTEM |
| Prompt 3 — Per-chunk translation with glossary cross-reference | Translator user message |
| Prompt 4 — Readability pass (never alters meaning) | SMOOTHER_SYSTEM |

---

## Pipeline Architecture

### Single Section Mode

```
Browser (page.tsx)
      │
      │  POST /api/translate
      │  { text: string, chapterTitle?: string }
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│  Next.js API Route  (app/api/translate/route.ts)             │
│                                                              │
│  ReadableStream ──► text/event-stream ──► Browser            │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  01. CHUNKER                                         │   │
│  │  Model: claude-sonnet-4-20250514                     │   │
│  │  Input:  raw Gujarati text                           │   │
│  │  Output: string[] — ≤500-word chunks at paragraph    │   │
│  │          and verse boundaries                        │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ chunks[]                          │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  02. TRANSLATOR                                      │   │
│  │  Model: claude-sonnet-4-20250514                     │   │
│  │  System: TRANSLATOR_SYSTEM                           │   │
│  │    → Full house rules (British English, diacritics   │   │
│  │      policy, mandatory terminology, tone rules)      │   │
│  │    → Full key glossary (~50 canonical terms)         │   │
│  │    → "Trustee of tradition" Gold Standard Prompt 2   │   │
│  │  Input:  chunk + running translation memory          │   │
│  │  Output: English translation                         │   │
│  │  Loop:   sequential; memory updated after each chunk │   │
│  └───────────────────────┬──────────────────────────────┘   │
│            ↕ memory      │ translations[]                    │
│  ┌─────────────────────┐ │                                   │
│  │ MEMORY EXTRACTOR    │ │                                   │
│  │ Model: claude-haiku │ │                                   │
│  │ Extracts proper noun│ │                                   │
│  │ decisions after each│ │                                   │
│  │ chunk for next run  │ │                                   │
│  └─────────────────────┘ │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  03. REVIEWER                                        │   │
│  │  Model: claude-sonnet-4-20250514                     │   │
│  │  System: REVIEWER_SYSTEM                             │   │
│  │    → All house rules                                 │   │
│  │    → 79+ explicit before/after correction examples   │   │
│  │      (mandir not temple, Swami not saint, etc.)      │   │
│  │  Input:  original Gujarati + English translation     │   │
│  │  Output: { score: 0–100, issues: string[],           │   │
│  │            revised: string }                         │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ reviewed[]                        │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  04. SMOOTHER  (Gold Standard Prompt 4)              │   │
│  │  Model: claude-sonnet-4-20250514                     │   │
│  │  Input:  reviewed/revised translation per chunk      │   │
│  │  Rules:  smooth flow, natural transitions,           │   │
│  │          restructure long sentences                  │   │
│  │  Hard constraints: never alter quotes, verses,       │   │
│  │          proper nouns, dates, numbers                │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ smoothed[]                        │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  05. ASSEMBLER                                       │   │
│  │  Model: claude-sonnet-4-20250514                     │   │
│  │  max_tokens: 16,000                                  │   │
│  │  Input:  all smoothed chunks joined                  │   │
│  │  Output: single coherent publication-ready document  │   │
│  │  Skipped if only 1 chunk (returned directly)         │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Book Mode (whole-book orchestration)

```
Browser (page.tsx) — orchestrates across multiple API calls

  Upload PDF/DOCX
        │
        ▼
  POST /api/upload
  → Claude PDF vision extracts Unicode text (handles Gujarati fonts)
  → Chapter detection via heading patterns
  → Returns: { text, chapters[], isBookMode }
        │
        ▼
  For each chapter (sequential):
        │
        ├─► POST /api/translate { text: chapterText, chapterTitle }
        │   → Full 5-agent pipeline
        │   → Returns output via SSE
        │
        ├─► Chapter result stored in bookOutputs[]
        ├─► Chapter bar progress updated
        └─► Next chapter...

  Final: all chapter outputs joined → displayed as single document
```

### Cross-Chunk Translation Memory

After each translated chunk, a lightweight Haiku call extracts proper noun and term decisions (e.g. "• ગઢડા → Gadhada") and appends them to a running memory string (capped at 2,000 chars). This memory is prepended to every subsequent translator call, ensuring consistency across a long document without requiring a shared session.

---

## SSE Event Schema

```typescript
// Chunker
{ stage: 'chunker', status: 'running' }
{ stage: 'chunker', status: 'done', count: number, chunks: string[], context: string }

// Translator
{ stage: 'translator', status: 'running' }
{ stage: 'translator', status: 'progress', current: number, total: number, index: number, translation: string }
{ stage: 'translator', status: 'done', memorySize: number }

// Reviewer
{ stage: 'reviewer', status: 'running' }
{ stage: 'reviewer', status: 'progress', chunk: number, total: number, index: number, score: number, issues: string[], revised: string }
{ stage: 'reviewer', status: 'done', avgScore: number }

// Smoother
{ stage: 'smoother', status: 'running' }
{ stage: 'smoother', status: 'progress', current: number, total: number, index: number }
{ stage: 'smoother', status: 'done' }

// Assembler
{ stage: 'assembler', status: 'running' }
{ stage: 'assembler', status: 'done', output: string, wordCount: number, avgScore: number }

// Error (any stage)
{ error: string }
```

---

## Model Allocation

| Agent            | Model                       | Max Tokens | Rationale |
|------------------|-----------------------------|------------|-----------|
| Chunker          | claude-sonnet-4-20250514    | 4,096      | Lightweight JSON structural task |
| Translator       | claude-sonnet-4-20250514    | 4,096      | Full gold standard context injection |
| Memory Extractor | claude-haiku-4-5-20251001   | 512        | Lightweight; fire-and-forget |
| Reviewer         | claude-sonnet-4-20250514    | 4,096      | Structured JSON + correction rules |
| Smoother         | claude-sonnet-4-20250514    | 8,192      | Readability pass per chunk |
| Assembler        | claude-sonnet-4-20250514    | 16,000     | Full-document join |
| PDF Extractor    | claude-sonnet-4-20250514    | 8,192      | Native document vision for PDFs |

---

## File Upload Flow

```
Browser: drag-drop or file picker (PDF / DOCX / TXT)
      │
      │  POST /api/upload  (multipart/form-data)
      ▼
┌─────────────────────────────────────────────────┐
│  app/api/upload/route.ts                        │
│                                                 │
│  .pdf  → Claude vision (base64 document)        │
│          Prompt: extract all text, mark         │
│          chapters as "=== CHAPTER: title ==="   │
│          Handles Gujarati Unicode correctly      │
│                                                 │
│  .docx → mammoth.extractRawText()               │
│                                                 │
│  .txt  → Buffer.toString('utf-8')               │
│                                                 │
│  Returns: {                                     │
│    text: string,                                │
│    filename: string,                            │
│    wordCount: number,                           │
│    chapters: { title, startLine }[] | null,     │
│    isBookMode: wordCount > 3000                 │
│  }                                              │
└─────────────────────────────────────────────────┘
```

---

## Client State Machine

```
idle
 │
 ├─► [Run clicked]
 │     → validate word count (≤10,000 per section)
 │     → isRunning = true, reset state, setTab('pipeline')
 │
 │   if book mode (chapters detected):
 │   │
 │   │   for each chapter (i = 0..N):
 │   │     → setCurrentChapterIdx(i)
 │   │     → bookChapters[i].status = 'running'
 │   │     → runSection(chapterText, chapterTitle)
 │   │         → SSE stream (same event handling as single mode)
 │   │     → bookChapters[i].status = 'done' | 'error'
 │   │     → bookOutputs[i] = result.output
 │   │
 │   │   → combine all outputs → setOutput()
 │   │   → setTab('output')
 │   │
 │   else (single section):
 │     → runSection(inputText)
 │     → setOutput(result.output)
 │     → setTab('output')
 │
 └─► isRunning = false
```

---

## Environment Variables

| Variable            | Required | Description                               |
|---------------------|----------|-------------------------------------------|
| `ANTHROPIC_API_KEY` | Yes      | Set in Vercel dashboard + `.env.local`    |

Note: the key must be trimmed of whitespace — the route calls `.trim()` before use.

---

## Deployment

```
Platform:   Vercel (serverless)
Build cmd:  next build
Region:     Auto

Function timeouts (vercel.json):
  /api/translate  → maxDuration: 300s  (requires Pro plan)
  /api/upload     → maxDuration: 60s

Practical capacity per pipeline run:
  ~3,000–5,000 words comfortably within 300s
  ~10,000 words is the hard cap (will timeout above this)
  Full books: use book mode — each chapter is a separate 300s window
```

### Deploy

```bash
cd web/
git add . && git commit -m "your message"
git push origin main        # GitHub stays in sync
npx vercel --prod --yes     # Deploy to Vercel
```

---

## Known Constraints & Roadmap

| Constraint | Detail | Resolution path |
|---|---|---|
| Vercel 300s timeout | Limits each section to ~5,000 words | Move to Railway / Fly.io / Modal for persistent workers |
| Sequential chunk processing | Chunks processed one at a time | Parallelise with `Promise.all` — watch API rate limits |
| No persistence | Results lost on refresh | Add Vercel KV or Supabase to store sessions |
| Book mode requires chapter detection | Flat documents not auto-split | Add manual chapter-split UI |
| Memory extractor is async fire-and-forget | Memory lags one chunk behind | Await it before next chunk (trades speed for consistency) |
| PDF chapter detection heuristic | Regex-based — may miss some headings | Improve with Claude-based chapter extraction in upload route |
