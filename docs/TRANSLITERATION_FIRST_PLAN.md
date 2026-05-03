# Transliteration-First Pipeline Redesign — BMAD Plan

**Date:** 2026-05-03
**Source:** BMAD party-mode review (Winston, John, Sally, Amelia, Quinn, Paige)
**Status:** Plan — not yet implemented. Awaiting Jay's go on the verb decision.

---

## TL;DR

The product's primary verb shifts from **Translate** to **Transliterate** (or "Romanise" — see PM note below). Translation becomes an optional secondary CTA. Big PDFs are processed **page-by-page** in the local worker (one Claude Sonnet vision call per page, max 3 in flight) — eliminating the multi-page chunk throttling we hit yesterday.

---

## Architecture (Winston)

**1. Firestore job shape.** Single parent job `transliterationJobs/{jobId}` with N child docs at `transliterationJobs/{jobId}/pages/{pageNum}`. The user's mental model is one document → one progress UI → one final artifact. Pages are an implementation detail (fan-out workers, fan-in assembly). Parent holds `status`, `pageCount`, `pagesCompleted`, aggregated `progress`; children hold `{ ocrStatus, gujaratiText, attempts, error }`.

**2. Worker concurrency: 3 concurrent OCR pages.** 1-page OCR validated at ~10 s; 10-page batches throttled silently. Three in-flight keeps wall-clock at ~`ceil(N/3) × 10 s`, leaves headroom under the SDK's implicit OAuth rate limit, and doesn't stack on the existing translator `BATCH=5` (OCR finishes before translation starts).

**3. Translation chunking — re-chunk on assembled Gujarati.** Don't treat pages as chunks. The existing `deterministicChunk` is verse-aware (300–500 words, verse-block joining); a single PDF page is often 80–150 words and would fragment a verse mid-stanza. Page boundaries are physical artifacts; chunk boundaries are semantic. Concatenate `pages[].gujaratiText` with `\n\n`, then run the existing pipeline unchanged.

**4. Failure / resume.** Per-page retry, parent stays `running`. Each page child has `attempts` (cap 3) and its own state machine: `queued → ocr_running → ocr_done | ocr_failed`. Parent transitions to `failed` only if any page exhausts retries. UI: page chip — `OCR'ing 4/12 · 1 retrying`. On worker restart, query `pages where ocrStatus in ['queued','ocr_failed'] and attempts < 3`. Translation only kicks off when `pagesCompleted === pageCount`.

**5. Vercel Blob fits cleanly.** Browser uploads original PDF directly to Blob (existing `/api/blob-token` path). Worker downloads once, runs `splitPdfIntoChunks(buf, 1)` locally, holds page splits in process memory (transient — no need to re-upload single pages).

**Top risks ranked:**
1. **OAuth token rotation mid-job** — `CLAUDE_CODE_OAUTH_TOKEN` 1-year lifetime; long PDFs spanning expiry kill resumes silently. Mitigate: pre-flight token check + structured 401 error.
2. **Page-level OCR drift on verse boundaries** — verses split across page breaks lose context, producing inconsistent transliteration at the seam. Mitigate: 2-page sliding-window for boundary pages only (post-MVP polish).

---

## Product Brief (John)

**User stories:**
- *As a devotee studying a discourse*, I want to paste a Gujarati passage and instantly see a clean Roman-script version, so I can read it aloud during paath without decoding the script.
- *As a sant or sadhak preparing katha*, I want to upload a single PDF chapter and receive a Roman-script document I can annotate, so I can rehearse pronunciation.
- *As an Aksharpith curator*, I want to upload a 200+ page book and get a chapter-segmented transliteration with the option to selectively translate sections, so I can publish bilingual study editions without paying the full translation cost up front.

**Success criteria:**
- **Latency:** pasted page (≤500 words) → output in ≤8 s P50 / ≤15 s P95. PDF chapter (~20 pages) ≤90 s. Full book streamed page-by-page, first page visible ≤60 s.
- **Accuracy:** subjective sant review ≥4.5/5 on a 20-passage rolling eval set. Zero tolerance for sacred-name errors (Swaminarayan, Akshar, Gunatitanand) — enforced deterministically via existing `protected-terms.ts`.
- **Output:** `.txt`, `.docx` (paragraph-preserving), copy-to-clipboard. `.pdf` deferred to polish.

**Primary verb decision** *(needs Jay's call):*
- **PM recommends "Romanise"** — devotees know it (Wikipedia, ISO 15919, BAPS publications use it), warmer than "Transliterate", leaves "Translate" cleanly available as secondary verb.
- **Architect/UX/Dev/Tech Writer assumed "Transliterate"** to match existing `lib/rules/transliterator-prompt.ts`.
- **Decision:** Jay picks one. Codebase identifiers stay `transliteration*` either way; only user-facing copy flips.

**Translation trigger:** Doc-level "Translate this" button after Transliteration completes, with per-paragraph "Translate this section" affordance on hover. Inline-per-page is too noisy for 200-page books and burns the OAuth quota; doc-level matches the dominant use case (read-aloud first, deep-study later).

**Done definitions:**
- **MVP:** paste/upload → Transliterate → render in scrollable view → `.txt`/`.docx` download → optional doc-level Translate. Single-pass, no chapter parallelism.
- **Polish:** per-paragraph translate-on-hover, sliding-window verse-boundary fix, parallel-column `.docx`, sant-review flagging, persistent library.

---

## UX Redesign (Sally)

**Layout — single canvas, two panes.** Replace the current "drop zone then pipeline" stack with a persistent two-pane workspace once a session begins. Left = **Source** (Gujarati input). Right = **Transliteration** (primary output). A segmented control at the top of the left pane toggles `Paste text | Upload file`. In paste mode the left pane is a live editable Gujarati textarea; in upload mode it becomes a thin file card plus a vertically scrollable **page reel** (small thumbnail strips of each OCR'd page). Right pane never reflows — transliteration is always the hero.

**Live progress for multi-page books.** A slim sticky **progress rail** spans the top of both panes: linear bar (`52 / 200 pages`), ETA, and a horizontally scrollable strip of tiny page chips colour-coded by status (queued: muted, OCR'ing: amber pulse, done: ink-green, error: red). Clicking a chip jumps both panes to that page. A single italic line streams worker commentary ("OCR'ing page 53 — detecting verse boundaries"). No spinner theatre.

**Output panel.** Per-page **collapsible sections** anchored to page numbers, not infinite scroll. Each section header shows `Page 53` with a tiny "view original" eye icon that side-slides the corresponding Gujarati beneath the Roman line for that page only. Verses render in italics; ā-only diacritics enforced. Sticky mini-TOC down the right edge lists page numbers; current page highlights as you scroll, mirroring the chip rail.

**Translate-to-English CTA.** Per-page, inline, as a quiet ghost button in each page section header (`Translate to English →`). On click, an English block expands *beneath* the transliteration for that page (accordion, never replaces). Global toolbar offers `Translate all completed pages` for batch.

**Mobile.** Panes stack vertically: Source collapses to a sticky summary card, Transliteration becomes the full screen. Progress rail keeps linear bar; chip strip collapses to `52 / 200 ▾`. Per-page TOC becomes a floating page-jump FAB.

**Three states to design:** (i) **Idle** — centred drop zone + paste tab; (ii) **Processing 50/200** — two panes live, rail amber, left reel shows 50 thumbnails done + 150 ghosted; (iii) **Complete + translation expanded** — rail collapses, one section open with three stacked language layers (Gujarati / Roman / English), italic verses intact.

---

## Implementation Plan (Amelia)

**File list (LOC delta):**

| File | LOC | What |
|---|---|---|
| `lib/job-types.ts` | ~50 | Add `TransliterationJob`, `PageJob`, discriminate via `kind: 'transliteration' \| 'translation'` |
| `app/api/upload/route.ts` | ~80 | PDF branch: skip inline OCR; Blob upload + parent + N child docs; return `{ jobId, totalPages }` |
| `scripts/local-worker.mjs` | ~200 | New `pollForPageJobs()` collectionGroup query, claim-txn, render single page → PNG, vision OCR, write Gujarati back. New `pollForTransliterationJobs()` for assembly + transliteration |
| `lib/pipeline.ts` | ~80 | Export `transliteratorAgent()`. Add `runTransliterationPipeline()` (chunker → transliterator → assembler → enforcer). Keep `runPipeline` for legacy |
| `lib/rules/transliterator-prompt.ts` | audit | Already exists — verify XML output contract |
| `lib/parser.ts` | ~15 | Add `parseTransliterator()` |
| `app/page.tsx` | ~400 | Subscribe to `transliterationJobs/{id}` + collection `pages`. Page-grid UI, assembled-Gujarati pane, transliteration pane, "Translate to English" CTA flips `translateRequested:true` |
| `app/admin/page.tsx` | ~50 | Tab/filter for `kind==transliteration`, page-completion ratio |

**Firestore schema:**

```
transliterationJobs/{jobId}
  kind: 'transliteration'
  uid, email, filename, pdfBlobUrl, totalPages: number
  status: 'pending'|'ocr-running'|'assembling'|'transliterating'|'done'|'failed'
  pagesCompleted: number, createdAt, completedAt, error
  gujaratiOutput?: string         // assembled
  transliteratedOutput?: string   // primary product
  translateRequested?: boolean
  translationOutput?: string      // optional secondary
  translationStatus?: 'idle'|'running'|'done'|'failed'

transliterationJobs/{jobId}/pages/{pageNum}
  pageNum: number, status: 'pending'|'ocr-running'|'done'|'failed'
  claimedBy?: string, claimedAt?: string
  gujaratiText?: string, wordCount?: number, error?: string, attempts: number
```

**Migration:** `translations/` and `jobs/` collections untouched. New `transliterationJobs/` runs alongside. Admin reads both. No backfill — historical docs stay readable in their existing route.

**Effort:** MVP **4 days**, polish **2 days**, total **~6 days / ~860 LOC delta** (1 dev).

**First PR — three sub-tasks (ordered):**
1. **Types + schema scaffolding** — extend `lib/job-types.ts`, write Firestore security rules for `transliterationJobs/**`, add `pdf-to-png-converter` dep.
2. **Upload route → page-job creation** — rewrite PDF branch in `app/api/upload/route.ts`; return `{ jobId, totalPages }`. Unit-test with 5-page fixture.
3. **Worker page poller** — `pollForPageJobs()` with claim-txn + vision OCR call; verify end-to-end via `node scripts/local-worker.mjs` against a seeded job. Defer assembly/transliteration to PR #2.

---

## Test Strategy (Quinn)

**Regression coverage — top 3 risks:**
1. **Transliterator output bypasses enforcer's rule chain.** Strengthen `lib/rules/__tests__/rules.test.ts` "protected terms survive a full pass" by piping a fixture *through transliterator → translator → smoother → enforcer*; assert all 20 PROTECTED_TERMS survive. Add chapter-1 snapshot test (byte-for-byte).
2. **Macron-ā preservation breaks when transliteration introduces new ā glyphs upstream.** Extend `macron-preservation.test.ts` with `transliteratorThenPreserveMacrons` case — prose ā passes through, verse ā restored, `DIACRITICS_MAP['ā']` remains undefined.
3. **Rule-list drift (33 rules / 12 diacritics length guards).** Meta-test asserting the new pipeline stage doesn't mutate exported rule arrays.

**New tests (transliteration MVP):**
- **Unit — ā-only enforcer:** `{ in: 'Bhagavān Svāmīnārāyaṇa', expected: 'Bhagwān Swāmīnārāyan' }`. Plus idempotency (run twice == once).
- **Unit — page-job assembler:** feed `[p3, p1, p2]`; assert assembled output is `[p1, p2, p3]` ordered correctly. Missing page → typed error, not silent gap.
- **Integration — fixture PDF → page-jobs → mocked SDK → assembled output:** 3-page fixture, `vi.mock('@anthropic-ai/sdk')`, assert (a) 3 jobs created, (b) round-trips through enforcer, (c) PROTECTED_TERMS survive.

**Page-count edge fixtures** in `fixtures/pdfs/`: `1-page.pdf`, `50-page.pdf`, `250-page.pdf` (chunking boundary), `encrypted.pdf`, `password-protected.pdf` → `PdfAuthError`, `mixed-script.pdf` (Gujarati + inline English), `corrupted.pdf` → `PdfParseError` (no unhandled throw).

**CI strategy:** default `npm test` mocks `@anthropic-ai/claude-agent-sdk` — no network, no quota burn. Single opt-in `lib/__tests__/integration/*.live.test.ts` gated on `RUN_LIVE_SDK=1`, nightly cron only, 1-page fixture.

**5-minute pre-deploy smoke:**
1. Upload `1-page.pdf` (Gujarati verse + prose); confirm 1/1 < 60 s.
2. Diff against committed `expected.txt`: PROTECTED_TERMS present, no forbidden diacritics (ī/ū/ṇ/ṣ), at least one ā in a verse line.
3. Re-run with `password-protected.pdf` → friendly toast, not stack trace.
4. Verify Firestore write: one doc with correct `pageCount`, `status: 'complete'`.

---

## Documentation Plan (Paige)

**Files to update:**
- `web/ARCHITECTURE.md` — retitle "Aksharpith Translator" → "Aksharpith Transliterator"; rewrite mission/Stage 2 to describe transliteration as primary, translation as optional downstream stage; add page-job ingestion section.
- `Mandir/CLAUDE.md` — "translation workspace" → "transliteration workspace"; update pipeline description and key paths.
- `web/README.md` (create if absent) — replace tagline + quickstart verbs.
- `web/app/page.tsx` — primary CTA + headline copy.
- `web/app/admin/page.tsx` — "back to translator" → "back to transliterator", stage chain const, tooltip wording.
- `web/lib/pipeline.ts` & `web/lib/terminology/` headers — update doc-comments.
- `web/app/api/translate/` route — add deprecation/aliasing note pointing to `/api/transliterate`.

**Headline shifts (before → after):**
| Surface | Before | After |
|---|---|---|
| Input page H1 | "Translate Gujarati sacred texts" | "Transliterate Gujarati sacred texts" |
| Input CTA | "Translate" | "Transliterate" (secondary: "Also translate to English") |
| Admin back-link | "← back to translator" | "← back to transliterator" |
| README tagline | "Gujarati-to-English translation pipeline" | "Gujarati transliteration pipeline (with optional English translation)" |
| Empty state | "No translations yet" | "No transliterations yet" |

**New documentation needed:**
- **Transliteration vs translation** — short explainer: transliteration preserves *sound*; translation conveys *meaning*. Transliteration default; translation opt-in.
- **Page-by-page OCR** — how uploads are split into page-jobs, OCR'd per page, reassembled before transliteration; why this beats whole-document OCR (resilience, parallelism, observability).
- **ā-only diacritic rule** — house rule: only `ā` is used; all other vowels remain unmarked. Do/don't examples.

**Mermaid diagram for ARCHITECTURE.md** (top-down flowchart):
`User input (PDF/image upload)` → `POST /api/upload` → `page-jobs[] (Firestore)` → `worker (local)` → `OCR per page (Sonnet vision)` → `assembled Gujarati text` → `Transliterator (Sonnet, ā-only rule + enforcer)` → branch: `Outputs (.docx/.txt)` and optional `Translator (Sonnet 6-stage)` → `Outputs (English .docx)`. Subgraphs: `Ingestion`, `OCR`, `Transliteration`, `Optional Translation`.

**Root `CLAUDE.md` Mandir row update:**
```
| **Mandir** | `Mandir/` | mandir, aksharpith, gujarati, transliteration, translation, baps, ocr | Gujarati transliteration pipeline (page-by-page OCR; optional English translation) |
```

---

## Synthesis — Ordered Task List (BMad Master)

### Phase 0 — Decisions needed from Jay (blocks Phase 1)
- [ ] **Verb call:** "Transliterate" (matches code) vs "Romanise" (PM recommends, friendlier). Decision affects only user-facing strings, ~10 places.
- [ ] **Confirm scope:** ship MVP first (paste + 1-page upload working end-to-end), then book-scale uploads in PR #3?

### Phase 1 — MVP (~4 days)

| # | Task | Owner files | Depends on |
|---|---|---|---|
| 1.1 | Add `TransliterationJob` + `PageJob` types | `lib/job-types.ts` | — |
| 1.2 | Firestore security rules for `transliterationJobs/**` | `firestore.rules` | 1.1 |
| 1.3 | Add `pdf-to-png-converter` dep + audit `transliterator-prompt.ts` | `package.json`, `lib/rules/` | 1.1 |
| 1.4 | Upload route: PDF branch creates parent + page docs | `app/api/upload/route.ts` | 1.1, 1.2 |
| 1.5 | Worker `pollForPageJobs()` — claim, OCR via SDK, write Gujarati back | `scripts/local-worker.mjs` | 1.1, 1.4 |
| 1.6 | Worker `pollForTransliterationJobs()` — assemble, transliterate, write back | `scripts/local-worker.mjs`, `lib/pipeline.ts` | 1.5 |
| 1.7 | New `runTransliterationPipeline()` + `parseTransliterator()` | `lib/pipeline.ts`, `lib/parser.ts` | 1.6 |
| 1.8 | UI rewrite — two-pane workspace, page-chip rail, per-page sections | `app/page.tsx` | 1.6 |
| 1.9 | Headline copy + verb update across UI | `app/page.tsx`, `app/admin/page.tsx` | 1.8 |
| 1.10 | Smoke test on 1-page + 5-page fixture PDFs | `lib/__tests__/integration/` | 1.6 |

### Phase 2 — Translation CTA + tests (~1 day)

| # | Task | Depends on |
|---|---|---|
| 2.1 | Per-page "Translate to English" ghost button → flips `translateRequested: true` | 1.8 |
| 2.2 | Worker handles `translateRequested === true` — runs translator+smoother on assembled Gujarati | 1.6 |
| 2.3 | Mocked-SDK regression suite: enforcer, macron, snapshot | 1.7 |
| 2.4 | Edge-case fixtures: encrypted, password-protected, mixed-script, corrupted | 2.3 |

### Phase 3 — Docs + admin + polish (~1 day)

| # | Task | Depends on |
|---|---|---|
| 3.1 | Rewrite `web/ARCHITECTURE.md` with new mermaid + page-by-page section | 1.7 |
| 3.2 | Update `Mandir/CLAUDE.md` + root `CLAUDE.md` Mandir row | 1.9 |
| 3.3 | Admin portal: filter by `kind=transliteration`, page-completion ratio column | 1.6 |
| 3.4 | README + in-app help text + empty states | 1.9 |

### Dependency graph (critical path)
`1.1 → 1.4 → 1.5 → 1.6 → 1.7 → 1.8 → 1.10` then Phase 2/3 parallel.

### Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OAuth token expires mid-job | Low (1-yr lifetime) | High (silent failure) | Pre-flight token check, structured 401 surfacing |
| Verse split across page boundary loses transliteration consistency | Medium | Medium | Sliding-window for verse-detected pages (post-MVP) |
| Worker crash leaves jobs claimed forever | Medium | Medium | Reaper: `claimedAt` > 10 min ago + retries < 3 → unclaim |
| 200+ page PDFs blow Firestore subcollection limits | Very low (limit 1M docs) | Low | N/A |
| User triggers Translate on 200-page doc, blocks pipeline | Medium | Medium | Translation runs sequentially behind a queue; UI shows progress |
| Existing translator regressions | Medium | Critical | Quinn's 3-tier regression suite must pass before Phase 1.7 ships |

### Definition of done
1. All Phase 1 tasks ticked.
2. `npm test` green (mocked).
3. 5-minute smoke from Quinn's plan passes.
4. Side-by-side judgement on a chapter-length input vs current pipeline — transliteration must be cleaner; translation output must match current quality (PROTECTED_TERMS preserved, no forbidden diacritics).
5. PR description per Sapio enterprise standards (what / why / how verified / risk).

---

*This plan is implementation-ready. Phase 0 verb decision unblocks everything else.*
