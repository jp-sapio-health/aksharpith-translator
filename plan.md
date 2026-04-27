# PR 3 — Pipeline Alignment to Sadhu's Approved Chain

## Goal
Replace the engineer-invented reviewer + recheck loop with the sadhu's approved 4-prompt chain. Keep deterministic layers (XML parser + rules enforcer) bulletproof. Score the reviewer down from a critical-path quality gate to optional admin-only telemetry.

## Pipeline shape

**Before (today):** chunker → translator → reviewer → recheck loop (≤3 calls) → smoother (with wordDiff guardrail) → assembler → enforcer. 4–7 model calls per chunk.

**After (this PR):** chunker → translator → smoother → enforcer → assembler. 2 model calls per chunk. Reviewer becomes async fire-and-forget admin telemetry, env-flagged off by default.

## Why
- The reviewer's 0–100 score is a subjective LLM grading another LLM. Jay does not trust it.
- The recheck loop compounds drift across passes.
- The smoother's `wordDiffRatio > 0.15 → discard` guardrail is a workaround for not following Prompt 4's actual "never change" list.
- JSON parse failures hide real signal behind a regex band-aid. The model often returns malformed JSON with embedded quotes in `revised`.
- The enforcer (deterministic regex) is where Jay's "regex and anything deterministic" instruction lands. It must be rock-solid; reviewer score drift is not.

## Output contract change: JSON → XML

XML is robust against the issues that bite JSON in this domain:
- Curly quotes (`""`) inside fields no longer need escaping.
- Verse blocks with line breaks no longer require `\n` encoding.
- Strict tag matching → either we get a `<translation>...</translation>` block or we throw — no silent score=50 fallback.

```
Translator output:
<translation>
The translated English prose, with verse blocks formatted as required.
</translation>
<flags>
<flag>Phrase the translator wasn't fully confident about</flag>
<flag>Another low-confidence span</flag>
</flags>
```

```
Smoother output:
<smoothed>
The polished prose.
</smoothed>
```

## Validation gate ("above 90%")
Jay's instruction: "I think if the output is above 90%, accept it. I don't really trust the whole percentage rating anyway." Interpretation: subjective side-by-side judgement vs gold-standard worked examples — not a model-generated number. Validation = re-translate two chapters and read both outputs side-by-side. If the new pipeline output is materially worse than the old reviewer-driven output, stop and surface the diffs.

## Scope
- `lib/rules/prompts.ts` — rewrite TRANSLATOR_SYSTEM (Prompts 1+2+3) and SMOOTHER_SYSTEM (Prompt 4 verbatim). Mark `buildReviewerSystem` `@deprecated`.
- `lib/pipeline.ts` — drop reviewer/recheck from the critical path. Keep `reviewerAgent` as `@deprecated` for one PR cycle (revert safety). Keep `rulesEnforcerAgent` untouched.
- `lib/__tests__/parser.test.ts` — new strict XML parser tests (≥10 cases, ≥95% branch coverage on the parser).
- `scripts/local-worker.mjs` — mirror new orchestration. Preserve per-stage `reportProgress` contract — the live UI depends on it.
- `app/api/translate/[jobId]/route.ts` — add `flags: string[]` to chunks; drop `score`, `certifiable`, `flagged`, `rechecked`, `reviewerSummary` from the user-facing payload (still written to Firestore).
- `app/api/admin/translate/[jobId]/route.ts` — new admin-guarded route exposing the full per-chunk score / categories / deductions for the /admin dashboard.
- Optional reviewer telemetry behind `ENABLE_REVIEWER_TELEMETRY=true` (default off). Logs to `progress.adminTelemetry.reviewerScore`. Never in user-facing response.

## Out of scope (explicitly)
- UI changes (those are PR 4).
- Switching from the Claude Agent SDK to the raw Anthropic API (separate decision).
- Filling rules-audit gaps (see below — Jay reviews and decides).
- Removing the deprecated reviewer code (next PR cycle, after revert window).

---

# Rules audit — gaps in code vs gold-standard PDFs

These are MISSING from `lib/rules/` (or only partially covered). I am NOT fixing them in this PR per Jay's instruction.

## Terminology rules not in `TERMINOLOGY_RULES`
| Term in source docs | Currently in code? | Notes |
|---|---|---|
| `bheedo` → hardships | No | Worked example, untranslated Gujarati form |
| `Gorat` → alluvial soil | No | Agricultural term |
| `Devta` (context: fire vs deity) | No | Context-dependent — auto-replace risky |
| `Ragdvesh` → aversion | No | Philosophical term |
| `pragatya` → birthday (in birthday context) | No | Context-dependent |
| `prophetic` → visionary | No | Avoid Abrahamic theological framing |
| `massaged with butter` → applied / anointed | No | Reverence-preserving verb swap |
| `Songiri bai` → A woman from Songiri | No | Phrase-level idiom |
| `BAPS is proud …` → neutral phrasing | No | Promotional tone — phrase-level, hard to auto-fix |
| `mutton` / `slaughter` softening rules | No | Sensitivity rules |
| `nishkami vartaman` definition expansion | Mentioned in prompt only | Not enforced |
| `arti` (already in TERMINOLOGY_RULES ✓) | Yes | |

## Personal name rules not in `PERSONAL_NAME_RULES`
| Source | Currently in code? |
|---|---|
| `Bhilalbhai` → Bhailalbhai | Yes ✓ |
| `Narayanda`/`Naranda` → Naran'da | Yes ✓ |
| `Shastriji Maharaj` (single token, must be two words) | Not enforced (only `Shrijimaharaj` is) |
| `Pramukhswami Maharaj` (must be two words) | No |
| `Mahantswami Maharaj` (must be two words) | No |

## Place name rules not in `PLACE_NAME_RULES`
| Source | Currently in code? |
|---|---|
| Chansad / Bamangam / Dhuliya / Dangara / Bhadrod / Piplana / Choksi | Yes ✓ |
| `Mumbai` (as historical-period reference) → `Bombay` | Only `Mumbai Province` covered. Bare `Mumbai` not auto-replaced (would be wrong in modern contexts). |
| `Saurashtra` → `Kathiawad` | Yes ✓ — but this is era-dependent; current rule is unconditional and may misfire on modern usage |

## Forbidden vocabulary not in `FORBIDDEN_VOCABULARY` / rules
| Source | Currently in code? |
|---|---|
| Most management jargon (CEO, strategy, stakeholder, roadmap, campaign, grassroots) | Partial — `stakeholder`, `campaign`, `grassroots` in list; `CEO`, `strategy`, `roadmap` not |
| Modern psychology terms (trauma, stress, anxiety, closure, coping) | Yes ✓ |
| `mythology` / `legend` / `folk belief` | `mythology` covered ✓; `legend`/`folk belief` not |
| `BAPS is proud` phrase-level | No |
| `prophetic` | No |
| `divinity`, `divine providence` (over-Westernised) | No |
| Decorative adjectives: `magnificent`, `glorious` | No |

## Master Glossary terms not surfaced in `KEY_GLOSSARY`
The Master Glossary PDF has thousands of entries (~8.9k lines extracted). `KEY_GLOSSARY` covers the most-frequent terms but is incomplete on:
- Vachanamrut-specific theological vocabulary (acharya, adharma, adhibhut, adhidev, adhyatma, Advaita, akartum, akshividya, Alok, Amas, …)
- Realm/cosmology beyond the 14-realm core (akshar-mukta variations, Chidakash, Mul-Purush)
- Many ritual / liturgical terms

## Recommendation (for a future PR, not this one)
Two follow-ups Jay should decide between:
1. Hand-curate a "tier 2" rules file from the worked-example doc — phrase-level rules that are common enough to be safe to enforce.
2. Programmatically extract terminology entries from the Master Glossary PDF into a structured glossary store. Then bind it into the translator system prompt by glob — currently the prompt only carries the inline `KEY_GLOSSARY` excerpt.

Neither is in scope here. The translator prompt rewrite below pulls in the existing rule modules; once the rule files grow, the prompt grows with them.

---

# Risk assessment for this PR

| Risk | Mitigation |
|---|---|
| New translator prompt produces materially worse output than the old reviewed-and-rechecked one | Validation step: re-translate 2 chapters, side-by-side judge ≥ 90% before commit. If worse, stop. |
| XML parser brittle to model output drift | ≥10 unit tests covering whitespace, fences, smart quotes, missing tags, nested quotes, empty flags, etc. ≥95% branch coverage target. |
| Live UI breaks because reportProgress contract changed | Preserve all existing per-stage progress messages. Drop only reviewer/rechecked rows. Flags surface as a chunk-level field. |
| Old jobs/translations in Firestore have `reviewerSummary` etc. that the user-facing route used to expose | Read path unchanged for `/translations/[id]` (the historical review page). The change is only in `/api/translate/[jobId]` for live polling. |
| Reviewer code deleted prematurely → no revert path | Mark `@deprecated`, do not delete in this PR. Next PR cycle removes it. |
