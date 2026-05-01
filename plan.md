# PLAN — Pipeline Pare-Down: Reviewer Removal + Context/Regex/Prompt Tidy

> **Status of previous plan.md:** PR3 (sadhu-approved chain, reviewer demoted to deprecated/telemetry-only) is **shipped**. This plan supersedes it.
> **This PR:** delete the deprecated reviewer entirely, consolidate context injection from the 4 master docs as the single source of truth, push every enforceable rule into the regex enforcer, and tighten the translator/smoother prompts so nothing is repeated.
> **Working title:** `pipeline-paredown`
> **Branch suggestion:** `feat/pipeline-paredown`

---

## 0 · Goal in one sentence

**Two LLM calls per chunk (translator → smoother), one deterministic enforcer, zero rechecking.** Every rule that can be a regex is a regex. The system prompt carries only the rules an LLM cannot enforce mechanically.

---

## 1 · Source-of-truth documents (read by code path, not pasted in)

All four live in `Mandir/NEW INFORMATION MASTER THE MOST IMPORTANT DOCUMENTS/`:

| # | Document | What it owns | Where it lives in code |
|---|---|---|---|
| 1 | `Aksharpith House Rules - 1.pdf` | The 10 house-rule sections (language, punctuation, diacritics, tone, etc.) | `lib/rules/house-rules.ts` (already mirrored, audit required) |
| 2 | `GOLD STANDARD PROMPTS.docx` | Prompts 1, 2, 3 (translator) + Prompt 4 (smoother) verbatim | `lib/rules/prompts.ts` |
| 3 | `Examples and Lessons from BAPS Translations.docx` | 100+ before/after corrections, certification checklist, pitfalls | `lib/rules/terminology.ts` (regex) + `lib/rules/forbidden-vocab.ts` |
| 4 | `Master Glossary - New - 06-11-25.pdf` | ~52pp, ~thousands of theological terms | `lib/rules/glossary.ts` (curated tier-1 excerpt, full extraction = future PR) |

**Rule:** The four master docs are the ONLY source of truth. Anything in the codebase that contradicts them is a bug. Anything in the codebase that doesn't trace to them is technical debt.

---

## 2 · Pipeline shape after this PR

```
chunker (deterministic, unchanged)
  → translator (LLM, XML out, single call)
    → enforcer (deterministic regex, applied to translator output)
      → smoother (LLM, XML out, single call)
        → enforcer (deterministic regex, applied to smoother output)
          → assembler (deterministic, unchanged)
            → enforcer (deterministic regex, final pass on assembled doc)
```

**Calls per chunk: 2 (translator + smoother).**
**No reviewer. No recheck loop. No telemetry path.** Determinism owns everything that can be deterministic.

---

## 3 · Scope

### 3.1 Deletions (irreversible — this is "totally remove")

| File | Action |
|---|---|
| `lib/pipeline.ts` | Delete: `ENABLE_REVIEWER_TELEMETRY` const, `reviewerAgent`, `ReviewResult` interface, `REVIEWER_SYSTEM` import, all `reviewerTelemetry` plumbing, `adminTelemetry` field on Firestore writes, the `if (ENABLE_REVIEWER_TELEMETRY) {…}` branch in `processChunk`. |
| `lib/rules/prompts.ts` | Delete: `buildReviewerSystem`. Delete: `buildAssemblerSystem` (already deprecated, assembler is deterministic). |
| `lib/rules/index.ts` | Remove `buildReviewerSystem` and `buildAssemblerSystem` exports. |
| `app/api/admin/translate/[jobId]/route.ts` | Delete the route entirely if its sole purpose was reviewer telemetry. If it serves other admin telemetry, strip only the reviewer-specific fields. **Investigation required during step 4.1.** |
| `lib/rules/types.ts` | Remove `ReviewComment` type if unreferenced after deletions. Run `grep -r ReviewComment` to confirm. |
| Firestore document shape | New translations no longer write `adminTelemetry`. Old translations retain it; read paths must tolerate `undefined`. |
| Env vars | `ENABLE_REVIEWER_TELEMETRY` removed from any `.env.example`, `vercel.json`, deployment notes. |

**No `@deprecated` halfway state this time.** PR3 used that as revert insurance. This PR is the removal.

### 3.2 Additions

| Where | What |
|---|---|
| `lib/rules/terminology.ts` | New regex rules from gap audit (see §5). |
| `lib/rules/forbidden-vocab.ts` | New entries from Examples DOCX gap list (see §5). |
| `lib/rules/personal-names.ts` *(new file, optional split)* | `Shastriji Maharaj`, `Pramukh Swami Maharaj`, `Mahant Swami Maharaj` two-word enforcement. |
| `lib/__tests__/enforcer.test.ts` *(new)* | Fixture-based tests for every new regex rule. |

### 3.3 Rewrites

| File | What changes |
|---|---|
| `lib/rules/prompts.ts` → `buildTranslatorSystem` | De-duplicate. Currently the prompt repeats house rules + key learnings + glossary inline. Replace with a single ordered injection: Prompt 1 (silent acknowledge, 1 paragraph) → Prompt 2 (locked rules, ≤15 bullets) → House Rules sections (from `formatHouseRulesForPrompt()`) → Glossary excerpt (from `KEY_GLOSSARY`) → Prompt 3 (constraints) → Output contract (XML). No content appears twice. |
| `lib/rules/prompts.ts` → `buildSmootherSystem` | Already verbatim Prompt 4. Audit: confirm zero deviation from DOCX. |
| `lib/pipeline.ts` → `processChunk` | Add **enforcer pass after translator output, before smoother input** (currently enforcer runs only after translator AND after smoother — keep both, but verify the post-translator pass is wired so the smoother sees a rules-clean input). Confirm logging unchanged so live UI doesn't break. |

---

## 4 · Tasks (ordered by dependency)

### Phase A — Reviewer removal (mechanical)

**A.1** Audit current admin route reviewer dependency.
- File: `app/api/admin/translate/[jobId]/route.ts` and any sibling admin pages.
- Action: `grep -rn "reviewerScore\|ENABLE_REVIEWER_TELEMETRY\|adminTelemetry\|certifiable\|categories" app/ lib/ scripts/`
- Output: list every reference, classify as (a) delete entire file, (b) strip fields only, (c) leave alone.

**A.2** Remove reviewer from `lib/pipeline.ts`.
- Delete imports: `buildReviewerSystem` from `./rules`.
- Delete: `ENABLE_REVIEWER_TELEMETRY` constant, `REVIEWER_SYSTEM` const, `ReviewResult` interface, `reviewerAgent` function (lines ~217-299 in current file).
- Delete: `reviewerTelemetry` array, the `if (ENABLE_REVIEWER_TELEMETRY)` block inside `processChunk` (lines ~452-461), the post-loop `Promise.all(reviewerTelemetry)` resolution block (lines ~521-529), and `adminTelemetry: adminTelemetry ?? null` from the Firestore write.

**A.3** Remove reviewer from `lib/rules/prompts.ts`.
- Delete: `buildReviewerSystem` function.
- Delete: `buildAssemblerSystem` function (deterministic assembler exists in pipeline.ts, this LLM version is dead).

**A.4** Update `lib/rules/index.ts` exports.
- Remove `buildReviewerSystem`, `buildAssemblerSystem` from the re-export block.

**A.5** Type cleanup.
- `grep -rn "ReviewComment\|ReviewResult"` — delete unreferenced types from `lib/rules/types.ts`.

**A.6** Worker mirror.
- File: `scripts/local-worker.mjs`.
- Action: mirror the same removals so local worker matches Vercel route.

**A.7** Env var cleanup.
- `grep -rn "ENABLE_REVIEWER_TELEMETRY"` across the repo.
- Remove from any `.env.example`, `vercel.json`, deployment docs, and `README.md` references.

**A.8** Firestore read-path safety.
- File: `app/translations/[id]/page.tsx` (or equivalent historical view).
- Confirm read-path tolerates `adminTelemetry === undefined` for new docs and `adminTelemetry: {…}` for old docs without crashing.

### Phase B — Regex audit + additions (close the gap from previous plan.md §"Rules audit")

**B.1** Add missing terminology rules to `lib/rules/terminology.ts`.

| Pattern | Replacement | Rule label | Source |
|---|---|---|---|
| `\bbheedo\b` (ci) | `hardships` | `bheedo→hardships` | Examples #59 |
| `\bGorat\b` | `alluvial soil` | `Gorat→alluvial soil` | Examples #61 |
| `\bRagdvesh\b` (ci) | `aversion` | `Ragdvesh→aversion` | Examples #68 |
| `\bSongiri bai\b` | `A woman from Songiri` | `Songiri bai→phrase` | Examples #79 (extract list) |
| `\bmassaged with butter\b` (ci) | `applied with butter` | `massaged→applied (reverence)` | Examples #71 |
| `\bprophetic\b` (ci) | `visionary` | `prophetic→visionary` | Examples #83 |
| `\bdivinity\b` (ci) | `divine grace` | `divinity→divine grace` | House Rules #2.1 spirit |
| `\bdivine providence\b` (ci) | `divine grace` | `divine providence→divine grace` | Examples #81 |

⚠ **Devta** is context-dependent (fire vs deity). Do NOT auto-replace. Add a translator-prompt note instead (§6.2). Same for **pragatya** (manifestation vs birthday).

**B.2** Add missing personal-name rules.
- File: `lib/rules/terminology.ts` (`PERSONAL_NAME_RULES`).

| Pattern | Replacement | Rule | Source |
|---|---|---|---|
| `\bShastrijimaharaj\b` | `Shastriji Maharaj` | `Shastrijimaharaj→two words` | Examples #54 spirit |
| `\bPramukhswami Maharaj\b` | `Pramukh Swami Maharaj` | `Pramukhswami→two words` | House Rules #2.3 |
| `\bMahantswami Maharaj\b` | `Mahant Swami Maharaj` | `Mahantswami→two words` | House Rules #2.3 |

**B.3** Audit forbidden-vocabulary list against Examples DOCX.
- File: `lib/rules/forbidden-vocab.ts`.
- Add: `CEO`, `strategy`, `roadmap`, `legend`, `folk belief`, `magnificent`, `glorious`, `prophetic`, `divinity`, `BAPS is proud` (phrase-level, flag-only — see B.4).
- Confirmed already present (do NOT add): `stakeholder`, `campaign`, `grassroots`, `mythology`, modern psychology terms.

**B.4** Phrase-level flagger (new mini-feature).
- Some forbidden phrases (e.g. `BAPS is proud`) cannot have a single safe automatic replacement. Instead of regex-replacing, the enforcer **flags** them and lets the smoother fix. Implementation: extend `RulesCorrection` shape with a `severity: 'fix' | 'flag'` field; for `flag`, the enforcer leaves the text unchanged and records the location/phrase. The user-facing translation view surfaces these as advisory flags (matches the existing `flags` chunk-level pattern). See §6.3.

**B.5** Quote/dash rules already implemented — verify.
- Existing: straight `"` → `“ ”` cycling, `'…'` → `‘…’`, `—` → ` – `.
- Action: regression test these don't regress. Add edge cases to `enforcer.test.ts`: nested quotes, quotes inside parentheses, multi-paragraph open/close balance.

**B.6** Diacritic-strip rule audit.
- Existing: `DIACRITICS_MAP` strips ī ū ṇ ṭ ṣ ś ṛ ṅ ḍ ñ → plain Roman.
- Confirm `ā` is **preserved** (House Rules §2.2 only-permitted diacritic, in poetic verse contexts).
- Add test fixture: a poetic verse with `ā` survives; a prose paragraph with stray `ī` is stripped.

**B.7** Date-format enforcement.
- House Rules §5: dates as `3 April 1781`, not `April 3, 1781`. Existing `DATE_FORMAT_RULES` cover this — verify with regression fixture.

**B.8** Hedging-strip rules.
- Existing `HEDGING_RULES` strip "It seems that", "perhaps", etc. Confirm coverage matches Examples #97 (no hindsight bias) and #79 (faith does not hedge).

### Phase C — Prompt rewrite (de-duplication, single injection per concept)

**C.1** Restructure `buildTranslatorSystem` as a single ordered injection with no repetition.

```
[Section P1] Editorial framework — one paragraph, silently acknowledged. Verbatim Prompt 1 from GOLD STANDARD PROMPTS.docx.
[Section P2] Locked rules — ≤15 bullets. Verbatim Prompt 2 from DOCX.
[Section HR] Aksharpith House-Style Guide — ${formatHouseRulesForPrompt()}. No inline restating.
[Section GL] Master glossary excerpt — ${KEY_GLOSSARY}. No inline restating.
[Section P3] Translation constraints — verbatim Prompt 3 from DOCX.
[Section CTX] Two context-dependent terms (fire vs deity, manifestation vs birthday) — explicit note that these are NOT regex-enforced and the translator must judge from context.
[Section OUT] Output contract — XML <translation> + <flags>. No JSON. No markdown fences.
[Section TG] Ultimate governing principle — Truth, Dignity, Clarity, Devotional sanctity, Historical precision (House Rules §10).
```

**Forbidden in this prompt** (these duplicate things the regex enforcer already does — they were dead weight):
- The 10-section house rules pasted twice.
- The "BEFORE/AFTER patterns" section.
- The `FORBIDDEN_LIST` inlined when `formatHouseRulesForPrompt()` already references it.

**C.2** Audit `buildSmootherSystem` against DOCX.
- Action: diff current implementation against the DOCX Prompt 4 line by line. Flag any drift. Replace with verbatim DOCX text + the existing `<smoothed>` XML output contract.
- The smoother prompt is short. It must stay short.

**C.3** Remove `buildReviewerSystem` and `buildAssemblerSystem` from prompts.ts (already covered in A.3 — listed here for completeness of the "prompt plan").

### Phase D — Pipeline wiring

**D.1** Confirm enforcer runs three times per chunk-flow.
- Translator out → enforcer (currently lines ~437-438 of pipeline.ts — verified present).
- Smoother out → enforcer (currently line ~476 — verified present).
- Final assembled doc → enforcer (currently lines ~514-515 — verified present).
- The post-translator pass is the most important: it ensures the smoother sees rules-clean input, so the smoother can never re-introduce a banned term that survives.

**D.2** Confirm `reportProgress` contract preserved.
- Stage names emitted: `chunker`, `translator`, `smoother`, `assembler`, `enforcer`. Reviewer stage is gone — confirm no stale `reviewer` stage name appears in any progress message.
- `chunkProgressArr[i]` shape: `{ index, original, translation, flags }`. No `score`, `certifiable`, `revised`.

**D.3** Worker parity.
- `scripts/local-worker.mjs` mirrors all of the above changes.

### Phase E — Tests

**E.1** Update parser tests.
- File: `lib/__tests__/parser.test.ts`.
- Confirm existing translator + smoother XML parser tests still pass after reviewer removal. They should — parser doesn't know about the reviewer.

**E.2** New enforcer tests.
- File: `lib/__tests__/enforcer.test.ts` (new).
- Coverage target: ≥95% branch coverage on `rulesEnforcerAgent`.
- Cases: every new regex from §B.1, §B.2, §B.3 plus regression cases for all existing rules (each rule needs at least one positive and one negative fixture).

**E.3** End-to-end smoke (manual).
- Run two real chapters through the pipeline (one Vachanamrut prose, one biographical narrative). Confirm output is comparable to or better than the PR3 baseline.

### Phase F — Validation gate

**F.1** Side-by-side judgement on two chapters.
- Pick the same two chapters used for the PR3 baseline. Re-translate with the new pipeline.
- Read both outputs side-by-side.
- Decision rule: if the new pipeline output is clearly worse, stop and surface the diffs. Do not merge.
- "Above 90%" interpretation = subjective sadhu-quality judgement, not a model-generated number.

**F.2** Doctrinal spot-checks.
- Verify: Akshar / Purushottam / Paramatma never collapsed; nishkami vartaman expanded correctly; Bombay Province era-correct; verses include Roman transliteration first.

---

## 5 · Determinism map

This is the explicit answer to "as DETERMINISTIC AS POSSIBLE":

| Concern | Owned by | Why |
|---|---|---|
| Chunking | Deterministic regex (chunker) | Already deterministic. Untouched. |
| Curly quotes / spaced en dashes / British -ize / diacritic strip / date format | Deterministic regex (enforcer) | All mechanical. Zero ambiguity. |
| Single-word terminology swaps (saint→Swami, temple→mandir, scripture→shastra, etc.) | Deterministic regex (enforcer) | Cheap, safe, exhaustive coverage. |
| Personal names + place names + two-word enforcement | Deterministic regex (enforcer) | Ditto. |
| Forbidden-vocab single-token replacements | Deterministic regex (enforcer) | Ditto. |
| Phrase-level flags ("BAPS is proud", contextual "Devta", contextual "pragatya") | Deterministic regex (enforcer, FLAG-only severity) | Cannot safely auto-replace. Surface to user as flag. |
| Sentence reordering, tone, devotional preservation, fidelity | LLM (translator, single pass) | Genuinely ambiguous. The LLM owns this. |
| Awkward-flow smoothing, transitions | LLM (smoother, single pass) | Genuinely ambiguous. Smoother owns this. |
| Quality scoring | **Nothing** | Deleted. Subjective LLM grading is untrusted. Validation is human side-by-side judgement. |

**Two LLM stages. Three deterministic stages (chunker, enforcer, assembler). Enforcer runs three times — after translator, after smoother, after assembly — so no LLM output ever survives without being reconciled against the rules.**

---

## 6 · Acceptance criteria (Given/When/Then)

**AC-1: Reviewer is gone.**
- *Given* a fresh checkout of this branch
- *When* I `grep -rn "reviewerAgent\|REVIEWER_SYSTEM\|ENABLE_REVIEWER_TELEMETRY\|ReviewResult\|adminTelemetry\|buildReviewerSystem\|buildAssemblerSystem"` across `lib/`, `app/`, `scripts/`
- *Then* I get zero matches.

**AC-2: Pipeline is two LLM calls per chunk.**
- *Given* a single-chunk translation job
- *When* I count network requests to `api.anthropic.com` during the run
- *Then* I see exactly 2 requests (translator + smoother).

**AC-3: All four master docs are reflected in code.**
- *Given* the audit table in §1
- *When* I trace each rule in `lib/rules/` to one of the four master docs
- *Then* every rule has a documented source line/section.

**AC-4: No content is repeated in the translator system prompt.**
- *Given* `buildTranslatorSystem()` output
- *When* I inspect the system prompt
- *Then* each rule, glossary entry, and forbidden term appears exactly once. No section is restated. The prompt is shorter than the previous version's `buildTranslatorSystem` byte count.

**AC-5: Smoother prompt matches Prompt 4 of the master DOCX verbatim.**
- *Given* `buildSmootherSystem()` output
- *When* I diff it against the Prompt 4 text in `GOLD STANDARD PROMPTS.docx`
- *Then* only the appended `<smoothed>` output contract block differs.

**AC-6: Enforcer runs three times per chunk-flow.**
- *Given* a chunk traversing the pipeline
- *When* the chunk reaches the assembler
- *Then* `rulesEnforcerAgent` has been invoked on (a) translator output, (b) smoother output, (c) assembled document. Confirmed by log line count or test instrumentation.

**AC-7: Side-by-side validation passes.**
- *Given* the same two chapters used for the PR3 baseline
- *When* both pipelines run
- *Then* a sadhu-quality side-by-side judgement says the new output is at least as good as the old. If not, the PR does not merge.

**AC-8: Old translation read-path doesn't break.**
- *Given* a Firestore translation document written by the previous pipeline (carrying `adminTelemetry`, `chunkData[].score`, etc.)
- *When* I open `/translations/[id]` for that document
- *Then* the page renders without errors. Old fields are simply ignored.

**AC-9: Test coverage on enforcer.**
- *Given* the new `lib/__tests__/enforcer.test.ts`
- *When* `npm test -- --coverage` runs
- *Then* `lib/rules/terminology.ts` has ≥95% branch coverage and `lib/pipeline.ts:rulesEnforcerAgent` has ≥95% branch coverage.

**AC-10: Live UI progress contract preserved.**
- *Given* the live UI polling `/api/translate/[jobId]`
- *When* a job runs end-to-end
- *Then* every previously-emitted stage name (`chunker`, `translator`, `smoother`, `assembler`, `enforcer`) still emits, in order, with the same `status: running|done|waiting` shape. No `reviewer` stage emits.

---

## 7 · Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Translator output without reviewer-recheck is materially worse | Medium | AC-7 side-by-side validation. Rollback by reverting the merge commit. |
| Phrase-level flagger is over-eager or noisy | Low–Medium | Start with a tight list (4–5 phrases). Expand only after observing real translations. |
| Two-word personal-name enforcement misfires inside a quoted verse where the source genuinely had it merged | Very Low | Personal-name regex uses `\b…\b` boundaries; verses are typically transliterated separately. Add a unit test. |
| `adminTelemetry` removal breaks an admin dashboard we forgot about | Low | A.1 audit step lists every reference before deletion. |
| `Saurashtra` → `Kathiawad` rule misfires on modern usage | Known (carried over from previous plan.md) | Out of scope for this PR. Existing rule kept unchanged. Future PR: era-aware rule. |
| Master Glossary PDF entries not in `KEY_GLOSSARY` (~1000s of terms) | Known (carried over) | Out of scope. Translator will rely on its own knowledge for tier-2 terms; the LLM is competent on common Sanskrit/Vachanamrut vocabulary. Programmatic extraction = future PR. |

---

## 8 · Out of scope (explicit, per Jay's instruction "no doubling up, no rechecking")

- ❌ Re-introducing any quality-scoring step under any name.
- ❌ Switching from raw Anthropic HTTPS to Claude Agent SDK (separate decision).
- ❌ Programmatically extracting the full Master Glossary PDF (future PR).
- ❌ Era-aware terminology (future PR).
- ❌ UI/admin dashboard changes beyond removing reviewer-only fields (future PR).
- ❌ Chunker changes (Jay's explicit instruction: "Just chunk as you are").

---

## 9 · File-touch summary

| File | Change |
|---|---|
| `lib/pipeline.ts` | Modify (delete reviewer code; reorder enforcer-around-smoother if needed) |
| `lib/rules/prompts.ts` | Modify (delete `buildReviewerSystem`, `buildAssemblerSystem`; rewrite `buildTranslatorSystem` with no duplication; verify `buildSmootherSystem` verbatim) |
| `lib/rules/index.ts` | Modify (remove dead exports) |
| `lib/rules/terminology.ts` | Modify (add new regex rules; potentially split personal-names into own file) |
| `lib/rules/forbidden-vocab.ts` | Modify (add new entries) |
| `lib/rules/types.ts` | Modify (remove dead types; add `severity: 'fix' \| 'flag'` to `RulesCorrection`) |
| `lib/rules/house-rules.ts` | Audit only — should already match House Rules PDF |
| `lib/rules/glossary.ts` | Audit only — `KEY_GLOSSARY` excerpt remains tier-1 only |
| `scripts/local-worker.mjs` | Modify (mirror pipeline removals) |
| `app/api/translate/[jobId]/route.ts` | Modify (drop reviewer fields if present; verify shape matches new pipeline output) |
| `app/api/admin/translate/[jobId]/route.ts` | Investigate (A.1) — delete file or strip fields |
| `app/translations/[id]/page.tsx` | Audit only — confirm read-path tolerates absent `adminTelemetry` |
| `lib/__tests__/parser.test.ts` | Audit only — confirm pass after reviewer removal |
| `lib/__tests__/enforcer.test.ts` | **New file** — fixture-based tests for every enforcer rule, ≥95% branch coverage |
| `.env.example`, `vercel.json`, README | Modify (remove `ENABLE_REVIEWER_TELEMETRY` references) |

---

## 10 · Definition of done

1. Every task in §4 ticked.
2. Every AC in §6 satisfied.
3. `npm test` green.
4. Side-by-side validation (§F.1) passed.
5. PR description includes: what changed, why, how verified, risk assessment (per Sapio Health enterprise standards).
6. Conventional Commits format on every commit.

---

*This plan is implementation-ready. A fresh dev agent — or `/bmad-bmm-quick-dev` with this file as input — can execute it without any further conversation context.*
