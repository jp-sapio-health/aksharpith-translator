# Aksharpith Translator — Technical Architecture

## Overview

A Next.js 15 web application that translates Gujarati religious/biographical text into publication-ready English using a **six-stage agentic pipeline** powered by the Anthropic Claude API. The pipeline runs server-side and streams real-time progress events to the browser via Server-Sent Events (SSE). Accepts paste, PDF, DOCX, DOC, TXT, and image (PNG/JPG/WEBP/GIF) input — including entire books via automatic chapter detection and sequential book-mode processing.

---

## Repository

```
GitHub:  https://github.com/jp-sapio-health/aksharpith-translator
Vercel:  https://aksharpith-translate.vercel.app
Deploy:  Automatic — push to main triggers Vercel production deploy
```

---

## Stack

| Layer        | Technology                                                     |
|--------------|----------------------------------------------------------------|
| Framework    | Next.js 15 (App Router)                                        |
| Language     | TypeScript 5                                                   |
| Styling      | Inline React styles + CSS custom properties (no CSS framework) |
| HTTP         | Node.js native `https` module (no SDK — bypasses Next.js fetch patching) |
| File parsing | `mammoth` (DOCX) · Claude PDF vision · Claude image OCR       |
| Hosting      | Vercel (serverless, 300s Pro timeout)                          |
| Runtime      | Node.js                                                        |
| Fonts        | Cormorant Garamond + Karla (Google Fonts)                      |

---

## File Structure

```
web/
├── app/
│   ├── layout.tsx                  # Root layout — font imports, metadata, viewport
│   ├── page.tsx                    # Main UI — 6 pipeline stages, file upload, chunk cards
│   ├── globals.css                 # CSS variables (light theme), keyframe animations
│   └── api/
│       ├── upload/
│       │   └── route.ts            # POST — PDF/DOCX/DOC/TXT/image extraction + chapter detection
│       └── translate/
│           └── route.ts            # POST — 6-agent pipeline, streams SSE
├── next.config.mjs                 # serverExternalPackages: [mammoth]
├── .env.local                      # ANTHROPIC_API_KEY (gitignored)
├── package.json                    # mammoth, next, react
└── ARCHITECTURE.md                 # This file
```

---

## Gold Standard Context

Three authoritative documents are baked into the system prompts as immutable constants:

| Document | Role | How used |
|----------|------|----------|
| `Aksharpith House Rules - 1.pdf` | Master editorial + translation rules | Embedded in `TRANSLATOR_SYSTEM`, `REVIEWER1_SYSTEM`, `REVIEWER2_SYSTEM` |
| `Master Glossary - New - 06-11-25.pdf` | ~200 canonical theological term definitions | Key terms in `KEY_GLOSSARY` constant |
| `Examples and Lessons from BAPS Translations.docx` | 79+ before/after correction examples | Critical corrections in `REVIEWER2_SYSTEM` |

A fourth document (`GOLD STANDARD PROMPTS.docx`) provided the prompt templates that shaped each agent's instructions:

| Prompt | Mapped to |
|--------|-----------|
| Prompt 1 — Context initialisation | `CHUNKER_SYSTEM` |
| Prompt 2 — "Trustee of tradition" mindset | `TRANSLATOR_SYSTEM` |
| Prompt 3 — Per-chunk translation with glossary | Translator user message |
| Prompt 4 — Readability pass | `SMOOTHER_SYSTEM` |

---

## Pipeline Architecture

### Six-Agent Pipeline

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
│  Keepalive pings every 10s to prevent Vercel idle timeout    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  01. CHUNKER                                         │   │
│  │  Splits text at paragraph/verse boundaries ≤500 words │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ chunks[]                          │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  02. TRANSLATOR                                      │   │
│  │  Full house rules + glossary + translation memory     │   │
│  │  Sequential; cross-chunk memory via Haiku extractor   │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ translations[]                    │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  03. CERTIFICATION AUDIT  (Reviewer 1)               │   │
│  │  BAPS Translation Certification Checklist:            │   │
│  │    8 categories (Terminology, Punctuation, Diacritics,│   │
│  │    Tone, Fidelity, Verse Handling, Historical,        │   │
│  │    Completeness) + 20 Common Pitfalls diagnostic      │   │
│  │  Output: per-category pass/fail, certifiable flag,    │   │
│  │          corrected revised text                       │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ reviewer1Results[]                │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  04. STYLE REVIEW  (Reviewer 2)                      │   │
│  │  House-style rules + 79+ before/after corrections     │   │
│  │  Input: Reviewer 1's corrected text (double pass)     │   │
│  │  Output: { score: 0–100, issues[], revised }          │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ reviews[]                         │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  05. SMOOTHER  (Gold Standard Prompt 4)              │   │
│  │  Readability pass — natural flow, transitions         │   │
│  │  Never alters quotes, verses, nouns, dates, numbers   │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ smoothed[]                        │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  06. ASSEMBLER                                       │   │
│  │  Joins all chunks into single publication-ready doc   │   │
│  │  Skipped if only 1 chunk (returned directly)          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Book Mode

```
Upload PDF/DOCX/image
      │
      ▼
POST /api/upload
  → Claude PDF vision / image OCR / mammoth extraction
  → Chapter detection (headings → TOC rejection → word-count fallback)
  → Returns { text, chapters[], isBookMode }
      │
      ▼
For each chapter (sequential):
  → POST /api/translate { text, chapterTitle }
  → Full 6-agent pipeline per chapter
  → Chapter bar progress updated in real-time
      │
      ▼
All chapter outputs joined → displayed as single document
```

---

## SSE Event Schema

```typescript
// Chunker
{ stage: 'chunker', status: 'running' }
{ stage: 'chunker', status: 'done', count: number, chunks: string[] }

// Translator
{ stage: 'translator', status: 'running' }
{ stage: 'translator', status: 'progress', current: number, total: number, index: number, translation: string }
{ stage: 'translator', status: 'done', memorySize: number }

// Reviewer 1 (Certification Audit)
{ stage: 'reviewer1', status: 'running' }
{ stage: 'reviewer1', status: 'progress', chunk: number, total: number, index: number, categories: Category[], pitfalls: string[], score: number, certifiable: boolean }
{ stage: 'reviewer1', status: 'done', certCount: number, total: number }

// Reviewer 2 (Style Review)
{ stage: 'reviewer2', status: 'running' }
{ stage: 'reviewer2', status: 'progress', chunk: number, total: number, index: number, score: number, issues: string[], revised: string }
{ stage: 'reviewer2', status: 'done', avgScore: number }

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

| Agent               | Model                     | Max Tokens | Rationale |
|---------------------|---------------------------|------------|-----------|
| Chunker             | claude-sonnet-4-20250514  | 4,096      | Lightweight JSON structural task |
| Translator          | claude-sonnet-4-20250514  | 4,096      | Full gold standard context injection |
| Memory Extractor    | claude-haiku-4-5-20251001 | 512        | Lightweight; fire-and-forget |
| Reviewer 1 (Cert)   | claude-sonnet-4-20250514  | 8,192      | 8-category checklist + revised text |
| Reviewer 2 (Style)  | claude-sonnet-4-20250514  | 8,192      | Structured JSON + 79 corrections |
| Smoother            | claude-sonnet-4-20250514  | 8,192      | Readability pass per chunk |
| Assembler           | claude-sonnet-4-20250514  | 16,000     | Full-document join |
| PDF Extractor       | claude-sonnet-4-20250514  | 32,000     | Multi-page PDF vision (up to 100 pages) |
| Image OCR           | claude-sonnet-4-20250514  | 32,000     | Claude vision for PNG/JPG/WEBP/GIF |

---

## File Upload

```
Browser: drag-drop or file picker
         PDF · DOCX · DOC · TXT · PNG · JPG · WEBP · GIF
         Up to 100 MB
      │
      │  XHR with upload progress tracking
      │  Phase 1: "Uploading 67%..." (file transfer)
      │  Phase 2: "Processing with Claude..." (text extraction)
      ▼
┌───────────────────────────────────────────────────────┐
│  app/api/upload/route.ts  (maxDuration: 120s)         │
│                                                       │
│  .pdf   → Claude PDF vision (base64, max 32MB)        │
│  .png/.jpg/.webp/.gif → Claude image OCR (max 20MB)   │
│  .docx  → mammoth.extractRawText()                    │
│  .doc   → mammoth attempt, graceful fallback           │
│  .txt   → Buffer.toString('utf-8')                    │
│                                                       │
│  → Chapter detection                                  │
│  → Returns { text, filename, wordCount, chapters,     │
│              isBookMode }                             │
└───────────────────────────────────────────────────────┘
```

---

## Environment Variables

| Variable            | Required | Description                               |
|---------------------|----------|-------------------------------------------|
| `ANTHROPIC_API_KEY` | Yes      | Set in Vercel dashboard + `.env.local`. Trimmed of whitespace at runtime. |

---

## Deployment

```
Platform:   Vercel (serverless)
Build cmd:  next build
Region:     Auto
Deploy:     Automatic on git push to main

Function timeouts:
  /api/translate  → maxDuration: 300s  (requires Pro plan)
  /api/upload     → maxDuration: 120s

Practical capacity:
  ~3,000–5,000 words per section comfortably within 300s
  ~50,000 words max per section (hard cap)
  Full books: book mode processes each chapter as a separate pipeline run
```

### Deploy

```bash
cd web/
git add . && git commit -m "your message"
git push origin main        # Vercel auto-deploys from GitHub
```

---

## Chunk Detail UI

Each chunk displays:

- **Collapsed**: chunk number, certification status (X/8 categories), quality score badge, issue count
- **Expanded**:
  - Quality score bar with tier explanation (90–100 Publication Ready → <60 Poor)
  - 8-category certification grid from Reviewer 1 (pass/fail per category with specific issues)
  - Colour-tagged issue list (CERT from Reviewer 1, STYLE from Reviewer 2)
  - Full final translation text

Score guide:
| Range   | Label              | Meaning |
|---------|--------------------|---------|
| 90–100% | Publication Ready  | Meets all Aksharpith standards |
| 80–89%  | Strong             | Minor issues corrected, ready for sign-off |
| 70–79%  | Revised            | Multiple corrections applied |
| 60–69%  | Needs Work         | Significant revision required |
| <60%    | Poor               | Consider retranslating |
