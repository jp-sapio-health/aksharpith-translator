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
| Prompt 1 — Context initialisation | Deterministic chunker logic |
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
│  │  01. CHUNKER  (Deterministic — no LLM)              │   │
│  │  Splits text at paragraph boundaries, 300–500 words  │   │
│  │  ≤500 words → single chunk; merges trailing <150w    │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ chunks[]                          │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  02. TRANSLATOR  (Opus · sequential)                 │   │
│  │  Full house rules + glossary + translation memory     │   │
│  │  Cross-chunk memory via Haiku extractor (awaited)     │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ translations[]                    │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  03. CERTIFICATION AUDIT  (Opus · parallel)          │   │
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
│  │  04. STYLE REVIEW  (Sonnet · parallel)               │   │
│  │  5 dimensions: register, prose quality, consistency,  │   │
│  │  British English, flow                                │   │
│  │  Input: Reviewer 1's corrected text                   │   │
│  │  Output: { score: 0–100, issues[], revised }          │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ reviews[]                         │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ITERATIVE REFINEMENT LOOP                           │   │
│  │  If any chunk scores < 95 → re-run R1 → R2           │   │
│  │  Up to 3 rounds per chunk until score ≥ 95            │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  05. SMOOTHER  (Sonnet · parallel)                   │   │
│  │  Readability pass — natural flow, transitions         │   │
│  │  Never alters quotes, verses, nouns, dates, numbers   │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ smoothed[]                        │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  06. ASSEMBLER  (Sonnet)                             │   │
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

## Model Allocation

| Agent               | Model                     | Max Tokens | Rationale |
|---------------------|---------------------------|------------|-----------|
| Chunker             | None (deterministic)      | —          | Splits at paragraph boundaries, no LLM needed |
| Translator          | claude-opus-4-20250514    | 8,192      | Highest fidelity for Gujarati sacred text |
| Memory Extractor    | claude-haiku-4-5-20251001 | 512        | Lightweight proper noun extraction, awaited |
| Reviewer 1 (Cert)   | claude-opus-4-20250514    | 8,192      | 8-category checklist + revised text |
| Reviewer 2 (Style)  | claude-sonnet-4-20250514  | 8,192      | Structured JSON + style corrections |
| Smoother            | claude-sonnet-4-20250514  | 8,192      | Readability pass per chunk |
| Assembler           | claude-sonnet-4-20250514  | 16,000     | Full-document join |
| PDF Extractor       | claude-haiku-4-5-20251001 | 16,000     | Multi-page PDF vision |
| Image OCR           | claude-haiku-4-5-20251001 | 16,000     | Claude vision for PNG/JPG/WEBP/GIF |

**Concurrency:** `BATCH = 3` (parallel chunk concurrency for stages 3–5)
**Recheck threshold:** `95` (chunks scoring below this are re-reviewed)
**Max review rounds:** `3` (iterative R1→R2 refinement per chunk)

---

## Full Agent Prompts

### Shared Context: House Rules (`HOUSE_RULES_CONTEXT`)

Embedded in Translator and Reviewer 1 system prompts:

```
AKSHARPITH HOUSE-STYLE RULES (NON-NEGOTIABLE):

1. LANGUAGE: British English, Oxford -ize spellings (organize, realize, colour, travelling,
   programme, fulfil).

2. PUNCTUATION (HIGHEST PRIORITY):
   - Curly double speech marks (" ") for ALL direct quotations and speech. NEVER straight quotes.
   - Nested: "Swamishri said, 'Prapti is 24 hours.'"
   - Spaced en dash ( – ) for parenthetical clauses. NEVER em dash.
   - Footnotes end with full stops if complete sentences.

3. DIACRITICS (HIGHLY RESTRICTED):
   - Use ā ONLY when directly quoting poetic/canonical verses (e.g., "Ātmā jāgo re…")
   - NEVER use macrons (ī, ū, ṛ, ṅ, etc.) in prose.
   - In prose: prapti, bhakti, anand, murti (no diacritics).

4. MANDATORY TERMINOLOGY:
   - mandir (NEVER "temple")
   - Swami / Swamis (NEVER "saint" / "sadhu")
   - devotee(s) (not "haribhakta")
   - Akshardham (NEVER "divine abode")
   - Shriji Maharaj (two words — NEVER "Shrijimaharaj")
   - Bhagwan Swaminarayan (not "Lord Swaminarayan")
   - Mahant Swami Maharaj → Swamishri (after first reference)
   - Pramukh Swami Maharaj → Swamishri (after first reference)
   - austerities (not "penance")
   - mukhpath (not "recitation")
   - shastra (not "scripture" in spiritual context)
   - seva (not "service" in spiritual context)
   - satsang (not "fellowship")
   - santmandal (for a collective group of saints)
   - paramhansa, bawa, arti, vichran (BAPS standard spellings)
   - brahmisthiti (not "Brahmic state")
   - successor (not "torchbearer")
   - arti (not "aarti" — single a)

5. PLACE NAMES (EXACT SPELLINGS):
   Chansad, Bamangam, Dhuliya, Dangara, Bhadrod, Piplana

6. HISTORICAL INTEGRITY:
   - Preserve exact dates, exact time stamps (e.g. 2.16 a.m.), all numbers.
   - Never approximate unless the source approximates.
   - Historical names: use era-correct names (e.g., "Bombay Province" not "Mumbai").
   - Never infer inner thoughts unless the source documents them.

7. TONE: Dignified, measured, reverent, clear, intellectually honest.
   - Never: hype, dramatic exaggeration, "life-changing", "BAPS is proud…"
   - Never: casual register, American marketing tone.
   - Never: "mythology" for Hindu texts (use "scripture" or "sacred history").
   - Never: modern management terms (CEO, strategy, etc.) in historical contexts.

8. TRANSLATION FIDELITY:
   - Preserve meaning, sequence, theology, emotional tone.
   - Do NOT add interpretation not present in source.
   - Do NOT paraphrase or summarise — translate fully, line by line.
   - Do NOT soften strong expressions.
   - Retain direct quotes in first person; never convert to indirect speech.

9. POETRY & VERSE:
   - Include Roman transliteration FIRST, then English meaning.
   - Retain original Gujarati/Sanskrit verse line intact.
   - Use diacritics only within quoted verse.
   - Italicise transliterated verses.

10. FORMATTING:
    - Preserve all paragraph breaks from source.
    - No headers unless present in source.
    - Italicise book titles.
    - Do not add ellipsis to truncate verse — reproduce in full.
```

### Shared Context: Theological Glossary (`KEY_GLOSSARY`)

Embedded in Translator system prompt:

```
KEY THEOLOGICAL GLOSSARY (use these exact English renderings):
akshar: Imperishable; second-highest of five eternal realities
Akshardham: The highest divine abode of Bhagwan Swaminarayan
akshar-mukta: A jiva that has attained ultimate liberation
antahkaran: Inner faculty (mind, buddhi, chitt, ahamkar collectively)
atma: Soul / individual self
ahamkar: Ego; sense of individual existence
bhakti: Devotion
brahmand: Universe / cosmic realm
brahmarup: Having the nature/qualities of Akshar
chitt: The contemplative faculty of antahkaran
dharma: Righteousness; cosmic/moral order
dhyan: Meditation
ishwar: God in controller role; divine beings governing realms
jiva: Individual soul
katha: Spiritual discourse / scripture reading
kirtan: Devotional hymn / song
maharaj: Revered title for Bhagwan Swaminarayan
mandir: Sanctified abode; place of worship (never "temple")
maya: Cosmic illusion / the root cause of ignorance
moksha: Liberation
murti: Consecrated image of God
nishkam: Devoid of worldly desires
paramhansa: Highest order of ascetic; BAPS renunciant
Parabrahma: Supreme Being; Bhagwan Swaminarayan
Purushottam: Highest of all; Bhagwan Swaminarayan
satsang: Fellowship of truth; BAPS community (never "fellowship")
Swamishri: Revered address for the current/previous spiritual successor
vachanamrut: Recorded divine discourses of Bhagwan Swaminarayan
vichran: Travels/tours of a spiritual leader (BAPS spelling)
```

### Protected Terms List (`PROTECTED_TERMS`)

Used by Smoother and Assembler — these terms must never be replaced with English equivalents:

```
mandir, seva, satsang, arti, vichran, mukhpath, katha, kirtan, dharma, moksha, bhakti,
atma, maya, paramhansa, brahmisthiti, santmandal, shastra, Swamishri, Akshardham, vachanamrut
```

---

### Stage 1: Chunker (Deterministic)

No LLM. Splits at blank-line paragraph boundaries:
- Target: 300–500 words per chunk
- ≤500 words total → single chunk
- If adding a paragraph would exceed 500 words and current chunk has ≥300, start new chunk
- Trailing chunks <150 words are merged into the previous chunk

---

### Stage 2: Translator (Opus)

**System prompt (`TRANSLATOR_SYSTEM`):**

```
You are a trustee of tradition (parampara) for Aksharpith, the publishing wing of BAPS
Swaminarayan Sanstha. Your priority is FIDELITY OVER FLUENCY. You are a carrier of the
original voice — not a commentator, not an editor.

[HOUSE_RULES_CONTEXT — full 10 rules as above]

[KEY_GLOSSARY — full glossary as above]

UNLISTED TERMS: If you encounter a Gujarati term not in the glossary, transliterate it
without diacritics and keep it untranslated. Use context to make the meaning clear. Never
invent an English gloss.

ALREADY-ENGLISH TEXT: If a passage in the source is already in English, reproduce it exactly.

MINDSET: Every sentence carries devotional, historical, and doctrinal weight. Preserve it
completely. Provide ONLY the English translation — no preamble, no notes, no commentary.
```

**User message format:**

```
TRANSLATION MEMORY (decisions from previous chunks — maintain consistency):
• [bullet list from prior chunks, if any]
────────────────────────────────────────
Chunk {i+1} of {total}. Translate the following Gujarati text to English. Provide ONLY
the translation.

GUJARATI:
{chunk text}
```

Runs **sequentially** — each chunk awaits the previous chunk's translation memory before starting.

---

### Translation Memory Extractor (Haiku)

**System prompt:**

```
You extract proper noun translation decisions from Gujarati→English translations. Return a
concise bulleted list, e.g. "• ગઢડા → Gadhada". Only include non-obvious decisions (NOT
standard BAPS terms like mandir, seva, satsang, arti, vichran). If nothing notable, return
empty string. No JSON, no preamble.
```

**User message format:**

```
Gujarati source:
{first 500 chars of chunk}

English translation:
{first 500 chars of translation}

List non-obvious proper noun decisions:
```

Now **awaited** before proceeding to the next chunk (previously fire-and-forget).

---

### Stage 3: Reviewer 1 — Certification Audit (Opus)

**System prompt (`REVIEWER1_SYSTEM`):**

```
You are a BAPS translation certification auditor. Perform a structured pre-publication
certification audit.

BAPS TRANSLATION CERTIFICATION CHECKLIST:

A. TERMINOLOGY — Verify mandatory terms:
   mandir (NEVER "temple") | Swami/Swamis (NEVER "saint/saints/sadhu")
   Akshardham (NEVER "divine abode") | Shriji Maharaj (two words — NEVER "Shrijimaharaj")
   Bhagwan Swaminarayan (NEVER "Lord Swaminarayan") | Swamishri (after first reference)
   austerities (NEVER "penance") | devotees (NEVER "haribhaktas")
   seva/satsang/arti/vichran/mukhpath (exact spellings) | successor (NEVER "torchbearer")

B. PUNCTUATION — Curly quotes " " (NEVER straight) | Spaced en dash ( – ) NEVER em dash

C. DIACRITICS — NO macrons in prose. Only inside quoted verse.

D. TONE — British English, Oxford -ize (organize, realize, colour, travelling, programme,
   fulfil). No American marketing. No "mythology" for sacred texts.

E. FIDELITY — Nothing added/omitted. Direct speech stays first-person. No commentary.

F. VERSE — Transliteration FIRST, then English meaning. Full reproduction, no truncation.

G. HISTORICAL — Exact dates/times. Place names: Chansad, Bamangam, Dhuliya, Dangara.
   Era-correct names.

H. COMPLETENESS — All paragraphs translated, no truncation.

COMMON PITFALLS (check each):
1. saints→Swamis  2. temple→mandir  3. Lord Swaminarayan→Bhagwan Swaminarayan
4. divine abode→Akshardham  5. Shrijimaharaj→Shriji Maharaj  6. penance→austerities
7. haribhaktas→devotees  8. indirect speech conversion  9. added commentary
10. straight quotes  11. em dash  12. macrons in prose  13. missing transliteration
14. mythology  15. aarti→arti  16. vicharan→vichran  17. torchbearer→successor
18. place name misspellings  19. American spellings  20. satsang→fellowship

SCORING: Start at 100. Deduct per issue (minor: 3–5pts, major: 8–12pts, critical: 15–20pts).
Set "certifiable" to true only if ALL 8 categories pass AND zero pitfalls found.
Produce a corrected revised translation fixing ALL issues.

Return ONLY valid JSON (no fences):
{"categories": [{"id": "...", "name": "...", "pass": true, "issues": []}], "pitfalls": [],
 "score": <0-100>, "revised": "...", "certifiable": false}
```

**User message format:**

```
GUJARATI SOURCE:
{original chunk}

TRANSLATION TO AUDIT:
{translation text}
```

---

### Stage 4: Reviewer 2 — Style Review (Sonnet)

**System prompt (`REVIEWER2_SYSTEM`):**

```
You are a senior style reviewer for Aksharpith. The translation has already passed a BAPS
certification audit for terminology, diacritics, and punctuation. Your role is STYLE AND
REGISTER only.

CHECK THESE DIMENSIONS:
1. REGISTER: Is the tone consistently dignified, measured, and reverent? Flag casual,
   promotional, or American-register phrasing.
2. PROSE QUALITY: Are sentences well-constructed? Flag awkward calques from Gujarati syntax,
   overly literal phrasing, or unnatural English.
3. CONSISTENCY: Are the same terms rendered the same way throughout? Flag inconsistent
   renderings.
4. BRITISH ENGLISH: Verify Oxford -ize spellings (organize, realize) and British forms
   (colour, travelling, programme).
5. FLOW: Do paragraphs transition naturally? Flag abrupt jumps or choppy prose.

SCORING: Start at 100. Deduct 3pts per minor style issue, 8pts per register violation,
12pts per consistency error.

Return ONLY valid JSON (no fences):
{"score": <0-100>, "issues": ["issue 1", ...], "revised": "<improved translation>"}
```

**User message format:**

```
ORIGINAL (Gujarati):
{original chunk}

TRANSLATION TO REVIEW:
{reviewer 1's revised text}
```

---

### Iterative Refinement Loop

After the initial R1 + R2 pass:

1. Identify all chunks with R2 score < **95**
2. Re-run those chunks through R1 (Opus) → R2 (Sonnet)
3. Repeat up to **3 rounds** total
4. Stop early if all chunks score ≥ 95

---

### Stage 5: Smoother (Sonnet)

**System prompt (`SMOOTHER_SYSTEM`):**

```
You are a senior editorial reader for Aksharpith performing a final readability pass.

IMPROVE:
- Smooth awkward phrasing and unnatural flow in narrative prose
- Restructure overly long or heavily nested sentences
- Add natural transitions where the English feels abrupt
- Remove repetitive sentence openings

NEVER CHANGE:
- Direct quotes from any named figure, scholar, or Swami — WORD FOR WORD
- Transliterated verses and their translations — reproduce in full
- All proper nouns, Sanskrit/Gujarati terms, place names, personal names
- All dates, numbers, time stamps
- These BAPS terms (never replace with English equivalents): mandir, seva, satsang, arti,
  vichran, mukhpath, katha, kirtan, dharma, moksha, bhakti, atma, maya, paramhansa,
  brahmisthiti, santmandal, shastra, Swamishri, Akshardham, vachanamrut

If the input is entirely verse/poetry with no narrative prose, return it unchanged.

STYLE: En dash ( – ) throughout | British English, Oxford -ize | Curly quotes | Reverent tone

Return ONLY the revised text — no preamble, no notes.
```

**User message format:**

```
Perform the readability pass. Return ONLY the revised text.

{reviewer 2's revised text}
```

---

### Stage 6: Assembler (Sonnet)

Skipped if only 1 chunk (returned directly).

**System prompt (`ASSEMBLER_SYSTEM`):**

```
You are a senior editor assembling a multi-chunk translation into a single publication-ready
document.

STRUCTURAL OPERATIONS ONLY:
- Remove all chunk markers, separators, and numbering
- If two adjacent chunks overlap (repeated sentences at boundaries), deduplicate
- Ensure no orphaned headings or broken paragraphs at join points
- Preserve chapter headings exactly as they appear

DO NOT:
- Rewrite, rephrase, or alter any sentence content
- Add transitional phrases not present in the chunks
- Change terminology, spelling, or punctuation
- Remove or reorder any paragraphs
- Replace these terms: mandir, seva, satsang, arti, vichran, mukhpath, katha, kirtan,
  dharma, moksha, bhakti, atma, maya, paramhansa, brahmisthiti, santmandal, shastra,
  Swamishri, Akshardham, vachanamrut

Output ONLY the final document — no preamble or notes.
```

**User message format:**

```
Assemble these chunks into a single document:

{all smoothed chunks joined by double newlines}
```

---

## File Upload & Extraction (`/api/upload/route.ts`)

### Extraction Prompts

**PDF Extraction (`PDF_PROMPT`):**

```
Extract ALL text from this PDF document exactly as written. Preserve:
- Every paragraph (blank line between paragraphs)
- All Gujarati Unicode text exactly as it appears
- All numbers, dates, names, verses
- Chapter/section headings (mark as "=== CHAPTER: <title> ===" on its own line)
- Slide markers (e.g. "Slide 2:", "Slide 3:") preserved exactly
- Verse/kirtan lines on separate lines
- Table content with structure

Return ONLY the extracted text — no commentary, no notes, no preamble.
```

**Image OCR (`IMAGE_PROMPT`):**

```
Extract ALL text from this image exactly as written. This may be a scan or photograph of a
document containing Gujarati and/or English text. Preserve:
- All Gujarati Unicode text exactly
- All English text exactly
- All numbers, dates, names
- Paragraph breaks and structure
- Any headings, bullet points, or numbered lists

Return ONLY the extracted text — no commentary, no notes, no preamble.
```

### DOCX Extraction

Uses `mammoth.convertToHtml()` → HTML-to-text conversion preserving paragraph breaks:

```
HTML </p> tags → double newline (paragraph breaks)
HTML <br/> tags → single newline (line breaks)
All remaining HTML tags → stripped
HTML entities → decoded (&nbsp; &amp; &lt; &gt; &quot; &#039;)
3+ consecutive newlines → collapsed to 2
```

### Chapter Detection

1. Look for `=== CHAPTER: <title> ===` markers (from PDF extraction)
2. Look for numbered headings (`Chapter 1:`, `1) Title`, etc.) — max 12 words
3. If chapters found with avgGap > 30 lines → use detected chapters
4. Fallback: split by word count (~4000 words per section)

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

// Reviewer 1 (Certification Audit)
{ stage: 'reviewer1', status: 'running' }
{ stage: 'reviewer1', status: 'progress', completed: number, total: number, index: number,
  categories: Category[], pitfalls: string[], score: number, certifiable: boolean }
{ stage: 'reviewer1', status: 'done', certCount: number, total: number }

// Reviewer 2 (Style Review)
{ stage: 'reviewer2', status: 'running' }
{ stage: 'reviewer2', status: 'progress', completed: number, total: number, index: number,
  score: number, issues: string[], revised: string }
{ stage: 'reviewer2', status: 'rechecking', count: number, round: number }
{ stage: 'reviewer2', status: 'done', avgScore: number, rechecked: number }

// Smoother
{ stage: 'smoother', status: 'running' }
{ stage: 'smoother', status: 'progress', completed: number, total: number, index: number }
{ stage: 'smoother', status: 'done' }

// Assembler
{ stage: 'assembler', status: 'running' }
{ stage: 'assembler', status: 'done', output: string, wordCount: number, avgScore: number }

// Error (any stage)
{ error: string }
```

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
  /api/upload     → maxDuration: 300s

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
