# Mandir Aksharpith — Implementation Plan

Generated: 2026-04-26
Source: BMAD party-mode review (Winston, Amelia, Quinn, Sally, John, Sophia, Mary, Victor, BMad Master)

---

## Sacred Constraints (do not violate)

The six rule files in `web/lib/rules/` represent ~1 year of curation. **Never modify their content.** Only add safety nets *around* them.

| Sacrosanct file | Lines | What it holds |
|---|---|---|
| `lib/rules/glossary.ts` | 229 | ~230 BAPS terms across 14 categories |
| `lib/rules/house-rules.ts` | 121 | 10-section house-style guide |
| `lib/rules/terminology.ts` | 106 | 47 enforced regex rules |
| `lib/rules/forbidden-vocab.ts` | 13 | 38 banned terms |
| `lib/rules/protected-terms.ts` | 8 | 20 BAPS terms the smoother must not touch |
| `lib/rules/prompts.ts` | 245 | 4 system-prompt builders |

Allowed operations on these files: **read only**. New files (tests, wrappers, runners) go alongside, never inside.

Sacred terminology updates require explicit Sant approval — out of scope.

---

## Test Inputs

| Input | Path | Purpose |
|---|---|---|
| Chapter 1 source | `Translation/WhatsApp Chat - AI x AMD (1)/-0006070-Notebook LLM Chapter 1.1.docx` | Regression baseline |
| Reference output | `web/test-output-chapter1.txt` | Snapshot target |
| Existing report | `web/test-report-chapter1.md` | Manual run log |
| Existing harness | `web/test-pipeline.mjs`, `web/test-e2e.mjs` | Smoke runners — keep |
| **Full 38k book** | *Jay to provide path before full-book run* | Production-scale validation |

---

## Tier 1 — This Week (ship floor)

Five items. All non-invasive on the gold-standard layer. Each is independently shippable.

### T1.1 — Strip stack trace from API errors
**File:** `web/app/api/translate/route.ts:56`
**Problem:** Returns `{ error, stack }` to clients — leaks file paths and internal structure. Violates Sapio standards.
**Fix:** Conditional on `NODE_ENV !== 'production'`. Stack only in dev.

### T1.2 — Firestore security rules in source control
**File (new):** `web/firestore.rules`
**File (edit):** `web/firebase.json` — add `firestore.rules` reference
**Rules baseline:**
- `jobs/{id}` — read/write only by `request.auth.uid == resource.data.uid`
- `translations/{id}` — same
- `translations/{id}/reviews/{rid}` — same author
- Default deny

### T1.3 — Vitest + rule regression tests
**File (edit):** `web/package.json` — add vitest devDep, test scripts
**File (new):** `web/vitest.config.ts`
**Files (new):** `web/lib/rules/__tests__/`
- `terminology.test.ts` — every rule in `TERMINOLOGY_RULES`, `PERSONAL_NAME_RULES`, `PLACE_NAME_RULES`, `FORBIDDEN_VOCAB_RULES`, `HEDGING_RULES`, `DATE_FORMAT_RULES` gets ≥3 cases (positive, negative, casing-preservation where applicable)
- `forbidden-vocab.test.ts` — every term in `FORBIDDEN_VOCABULARY` is reachable; no duplicates
- `protected-terms.test.ts` — every term in `PROTECTED_TERMS_LIST` is non-empty, lowercase invariant where expected
- `diacritics.test.ts` — `DIACRITICS_MAP` strips every entry correctly

These tests **assert behaviour, never modify content**. They are the year-of-work safety net.

### T1.4 — Chapter 1 snapshot guard
**File (new):** `web/lib/rules/__tests__/chapter1-snapshot.test.ts`
**Logic:** Run the deterministic post-processing chain (terminology + place names + diacritics) against `test-output-chapter1.txt` content. Snapshot result. Any future rule change that alters output must be deliberate.

### T1.5 — Rate limit on /api/translate
**File (new):** `web/lib/rate-limit.ts` — in-process token bucket (per-uid; capacity 5, refill 1/min). Sufficient for current single-worker setup; swap for Upstash when scale demands.
**File (edit):** `web/app/api/translate/route.ts` — call after auth, before job create. Return 429 on miss.

**Tier 1 done = green test run + manual chapter 1 run produces output identical to baseline.**

---

## Tier 2 — This Month

6. **Decompose `web/app/page.tsx` (1504 lines)** — extract `useJobPoller`, `useSSEStream`, `<ExportMenu />`, `<SectionEditor />`. Target: page.tsx ≤ 400 lines.
7. **Stage-output persistence** — write each stage's output to `jobs/{id}/stages/{n}` so retries skip completed stages. Cheap to add, large dev-loop win.
8. **Worker job-claim lock** — `claimedBy: workerId, claimedAt: timestamp` on jobs. Reject pickup if `claimedAt` < 10 min ago by another worker. Eliminates duplicate execution.
9. **Externalize glossary read-path** — add `lib/glossary-source.ts` that reads from Firestore `config/glossary` if present, falls back to `glossary.ts`. **No content change yet.** Editorial UI in Tier 3.
10. **PRD** — `web/docs/PRD.md`. Answers WHO uses this, WHAT success looks like, WHY 97%, WHO approves glossary changes.

---

## Tier 3 — This Quarter

11. **Per-chunk audit log** — every chunk's rubric breakdown + corrections persisted; sub-97 chunks queued for Sant review.
12. **Sant-curated gold-standard exemplars** — 10 reference paragraphs in translator system prompt as *positive* examples (current prompt is mostly negative — forbidden lists, banned hedges).
13. **Search product spike** — verse-level retrieval over translated corpus. The translator is the data factory; search is the product (per Victor).

---

## Execution Order

Tier 1 strictly sequential by ID: T1.1 → T1.2 → T1.3 → T1.4 → T1.5.
After T1.5: run vitest, then chapter 1 end-to-end via existing `test-pipeline.mjs`, then full book once Jay provides the path.

Tier 2 and 3 sequenced after Tier 1 ships.

---

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Test introduces unintended rule regression | Low | Tests assert *current* behaviour as baseline; zero rule edits in Tier 1 |
| Rate limit blocks legitimate Sant reviewer | Medium | Capacity 5 / refill 1/min is generous for one-Sant-at-a-keyboard; revisit if rejected |
| Firestore rules lock out existing data | Medium | Deploy rules to staging Firestore project first; verify with current uid; only then production |
| Snapshot test brittle on whitespace | High | Normalise whitespace in snapshot comparison; assert canonical form |
