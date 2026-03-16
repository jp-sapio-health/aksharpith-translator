# Aksharpith Translator — Technical Architecture

## Overview

A Next.js 15 web application that translates Gujarati religious/biographical text into publication-ready English using a **five-stage agentic pipeline** powered by the Anthropic Claude API. All prompts are sourced directly from `GOLD STANDARD PROMPTS.docx`. The pipeline runs server-side and streams real-time progress events to the browser via Server-Sent Events (SSE). Accepts paste, PDF, DOCX, DOC, TXT, and image (PNG/JPG/WEBP/GIF) input — including entire books via automatic chapter detection and sequential book-mode processing.

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
| Auth         | Firebase Auth (Google OAuth + email/password)                  |
| Database     | Firebase Firestore (translation history)                       |
| Hosting      | Vercel (serverless, 300s Pro timeout)                          |
| Runtime      | Node.js                                                        |
| Fonts        | Cormorant Garamond + Karla (Google Fonts)                      |

---

## File Structure

```
web/
├── app/
│   ├── layout.tsx                  # Root layout — font imports, metadata, Firebase AuthProvider
│   ├── page.tsx                    # Main UI — 5 pipeline stages, file upload, chunk cards
│   ├── globals.css                 # CSS variables (light theme), keyframe animations
│   ├── login/
│   │   └── page.tsx                # Login page — Google OAuth + email/password
│   ├── history/
│   │   └── page.tsx                # Translation history viewer
│   └── api/
│       ├── upload/
│       │   └── route.ts            # POST — PDF/DOCX/DOC/TXT/image extraction + chapter detection
│       ├── translate/
│       │   └── route.ts            # POST — 5-stage pipeline, streams SSE
│       └── history/
│           └── route.ts            # POST — query user's translation history
├── lib/
│   ├── auth-context.tsx            # Firebase Auth React context
│   ├── firebase.ts                 # Firebase client config
│   ├── firebase-admin.ts           # Firebase Admin SDK (server-side)
│   └── verify-auth.ts              # JWT token verification for API routes
├── next.config.mjs                 # serverExternalPackages: [mammoth, firebase-admin]
├── .env.local                      # ANTHROPIC_API_KEY + Firebase config (gitignored)
├── package.json                    # mammoth, firebase, firebase-admin, next, react
└── ARCHITECTURE.md                 # This file
```

---

## Gold Standard Prompts

All translation prompts are sourced **exactly** from `GOLD STANDARD PROMPTS.docx`:

| Prompt | Pipeline Stage | Description |
|--------|---------------|-------------|
| Prompt 1 | `TRANSLATOR_SYSTEM` (context) | Framework establishing fidelity, reverent tone, British English, restricted diacritics, doctrinal precision |
| Prompt 2 | `TRANSLATOR_SYSTEM` (mindset) | "Trustee of tradition" — carrier of original voice, curly quotes, en dashes, Oxford -ize, Akshardham/Purush/Shriji Maharaj terminology, historical integrity |
| Prompt 3 | `TRANSLATOR_SYSTEM` (constraints) | Per-chunk translation: glossary cross-reference, poetic lines (transliteration first), diacritics (ā only in verse), dignified register, speaker authority |
| Prompt 4 | `SMOOTHER_SYSTEM` | Readability pass: smooth phrasing, restructure nested sentences, natural transitions. Never change: direct quotes, transliterated verses, proper nouns. En dash, British English, italicise verses |

Supporting documents baked into constants:

| Document | Constant | Role |
|----------|----------|------|
| `Aksharpith House Rules - 1.pdf` | `HOUSE_RULES_CONTEXT` | 10 non-negotiable editorial rules |
| `Master Glossary - New - 06-11-25.pdf` | `KEY_GLOSSARY` | ~30 canonical theological term definitions |
| `Examples and Lessons from BAPS Translations.docx` | Informs `REVIEWER_SYSTEM` | 200+ before/after correction examples |

---

## Pipeline Architecture

### Five-Stage Pipeline

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
│  │  01. CHUNKER  (Deterministic — no LLM)              │   │
│  │  Verse-aware splitting at paragraph boundaries       │   │
│  │  300–500 words per chunk; single-newline fallback    │   │
│  │  ≤500 words → single chunk; trailing <150w merged    │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ chunks[]                          │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  02. TRANSLATOR  (Opus · chunk 0 sequential, rest    │   │
│  │      parallel in batches of 5)                       │   │
│  │  Gold Standard Prompts 1+2+3 + KEY_GLOSSARY          │   │
│  │  Cross-chunk memory via Haiku extractor (rolling)     │   │
│  │  ► enforceTerminology() applied to output             │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ translations[]                    │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  03. REVIEWER  (Opus · parallel batches of 5)        │   │
│  │  Weighted 97% Rubric:                                │   │
│  │    Fidelity 30 · Terminology 25 · Verse 15           │   │
│  │    Style 15 · Historical 10 · Completeness 5         │   │
│  │  Iterative: re-review if score < 96, up to 2 rounds  │   │
│  │  Output: per-category scores + corrected text         │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ reviews[]                         │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  04. SMOOTHER  (Sonnet · parallel batches of 5)      │   │
│  │  Gold Standard Prompt 4 — readability pass            │   │
│  │  Diff guard: if >15% char change, use reviewer output │   │
│  │  ► enforceTerminology() + postProcess() applied       │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ smoothed[]                        │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  05. ASSEMBLER  (Sonnet · single call)               │   │
│  │  Structural join only — no rewrites                   │   │
│  │  Skipped if only 1 chunk                             │   │
│  │  ► postProcess() applied to final output              │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Deterministic Post-Processors (zero LLM, every stage):     │
│  • enforceTerminology(): temple→mandir, penance→austerities │
│  • postProcess(): curly quotes, en dashes, strip forbidden   │
│    diacritics (keep only ā), clean up formatting             │
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
  → Full 5-stage pipeline per chapter
  → Chapter bar progress updated in real-time
      │
      ▼
All chapter outputs joined → displayed as single document
```

---

## Model Allocation

| Agent               | Model                     | Max Tokens | Rationale |
|---------------------|---------------------------|------------|-----------|
| Chunker             | None (deterministic)      | —          | Verse-aware paragraph splitting, no LLM needed |
| Translator          | claude-opus-4-20250514    | 8,192      | Highest fidelity for Gujarati sacred text |
| Memory Extractor    | claude-haiku-4-5-20251001 | 512        | Lightweight proper noun extraction, rolling |
| Reviewer            | claude-opus-4-20250514    | 16,000     | Weighted rubric certification + corrected text |
| Smoother            | claude-sonnet-4-20250514  | 8,192      | Readability pass per chunk |
| Assembler           | claude-sonnet-4-20250514  | 64,000     | Full-document join |
| PDF Extractor       | claude-haiku-4-5-20251001 | 16,000     | Multi-page PDF vision |
| Image OCR           | claude-haiku-4-5-20251001 | 16,000     | Claude vision for PNG/JPG/WEBP/GIF |

**Concurrency:** `BATCH = 5` (parallel chunk concurrency for stages 2–4)
**Recheck threshold:** `96` (weighted rubric score; chunks below this are re-reviewed)
**Max review rounds:** `2` (optimized for Vercel 300s timeout)
**API timeout:** `90s` per Claude call | **Max retries:** `1`

---

## Deterministic Post-Processors

Two pure-function post-processors run after LLM stages (zero API calls, 100% reliable):

### `enforceTerminology(text)`
Applied after Translator and after Smoother. Deterministic find-and-replace:
- temple(s) → mandir(s)
- penance → austerities
- torchbearer → successor
- aarti → arti
- vicharan → vichran
- Lord Swaminarayan → Bhagwan Swaminarayan
- divine abode → Akshardham
- Shrijimaharaj → Shriji Maharaj

### `postProcess(text)`
Applied after Smoother and after Assembler. Fixes:
- Straight quotes → curly quotes (" " and ' ')
- Em dashes (—) → spaced en dashes ( – )
- Strips all forbidden diacritics: ṁ→m, ṭ→t, ṣ→sh, ś→sh, ṇ→n, ī→i, ū→u, ṛ→r, ṅ→n, ḍ→d, ḥ→h
- Preserves ā (the only permitted diacritical mark)

---

## 97% Accuracy Rubric

Scoring is based on a **weighted rubric** derived from the compliance check in the user's 97% accuracy example:

| Category | Weight | What's Measured |
|----------|--------|-----------------|
| **Fidelity** | 30 | Nothing added/omitted. Every source sentence → English sentence. Direct quotes first-person. Exact numbers/dates/names. |
| **Terminology** | 25 | All mandatory BAPS terms correct (mandir, Swami, bawa, austerities, Shriji Maharaj, Akshardham, paramhansa, etc.) |
| **Verse Handling** | 15 | Transliteration FIRST then meaning. ā only in verse. Full reproduction. Consistent format. |
| **Style & Register** | 15 | UK English Oxford -ize. Curly quotes. Spaced en dashes. Dignified, reverent tone. |
| **Historical Precision** | 10 | Era-correct names (Bombay Province). Exact dates (3 April 1781). Exact place spellings. |
| **Completeness** | 5 | All paragraphs translated. No summarisation. No truncation. |

**Certifiable** = total ≥ 97 AND zero critical violations.

Deductions: Critical = −60% of category weight, Major = −40%, Minor = −20%.

---

## SSE Event Schema

```typescript
// Chunker
{ stage: 'chunker', status: 'running' }
{ stage: 'chunker', status: 'done', count: number, chunks: string[] }

// Translator
{ stage: 'translator', status: 'running' }
{ stage: 'translator', status: 'progress', current: number, total: number, index: number,
  translation: string }
{ stage: 'translator', status: 'done', memorySize: number }

// Reviewer (weighted rubric certification)
{ stage: 'reviewer', status: 'running' }
{ stage: 'reviewer', status: 'progress', completed: number, total: number, index: number,
  categories: Category[], pitfalls: string[], issues: string[],
  score: number, certifiable: boolean }
{ stage: 'reviewer', status: 'done', certCount: number, total: number,
  avgScore: number, rechecked: number }

// Smoother
{ stage: 'smoother', status: 'running' }
{ stage: 'smoother', status: 'progress', completed: number, total: number, index: number,
  flagged: boolean }
{ stage: 'smoother', status: 'done', flaggedChunks: number }

// Assembler
{ stage: 'assembler', status: 'running' }
{ stage: 'assembler', status: 'done', output: string, wordCount: number, avgScore: number }

// Error (any stage)
{ error: string }
```

---

## File Upload & Extraction (`/api/upload/route.ts`)

```
Browser: drag-drop or file picker
         PDF · DOCX · DOC · TXT · PNG · JPG · WEBP · GIF
         Up to 100 MB
      │
      ▼
┌───────────────────────────────────────────────────────┐
│  app/api/upload/route.ts  (maxDuration: 300s)         │
│                                                       │
│  .pdf   → Claude PDF vision (base64, max 32MB)        │
│  .png/.jpg/.webp/.gif → Claude image OCR (max 20MB)   │
│  .docx  → mammoth.convertToHtml() → text with breaks  │
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

| Variable            | Required | Description |
|---------------------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes      | Anthropic Claude API key (Production only on Vercel) |
| `FIREBASE_PROJECT_ID` | Yes    | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Yes  | Firebase Admin SDK service account email |
| `FIREBASE_PRIVATE_KEY` | Yes   | Firebase Admin SDK private key |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Yes | Firebase client API key |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Yes | Firebase auth domain |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Yes | Firebase project ID (client) |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Yes | Firebase storage bucket |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Yes | Firebase messaging sender ID |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Yes | Firebase app ID |

---

## Deployment

```
Platform:   Vercel (serverless)
Build cmd:  next build
Region:     Auto
Deploy:     Automatic on git push to main

Function timeouts:
  /api/translate  → maxDuration: 300s  (requires Pro plan)
  /api/upload     → maxDuration: 300s

Practical capacity:
  ~3,000–5,000 words per section comfortably within 300s
  ~50,000 words max per section (hard cap)
  Full books: book mode processes each chapter as a separate pipeline run
```
