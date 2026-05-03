# Aksharpith Redesign — Plan & ADR

**Status**: Draft — pending Jay's confirmation before any code changes.
**Date**: 2026-05-03
**Author**: BMAD party-mode synthesis (Sally + Winston + Amelia + Paige + BMad Master), revised after architectural discovery.

---

## TL;DR

Mandir's transliterator UI gets folded into bk-syllabus-hub's existing
`/tools/transliterator` route as a **unified pipeline-canvas** (upload zone +
live two-pane Gujarati ↔ Roman + page chips), matching bk's design
language (Tailwind v4, OKLCH palette, `--bk-orange` primary, Inter +
Noto Serif Gujarati). Mandir/web standalone gets the same UI via a shared
component. Worker stays where it is. Auth is bk's NextAuth — already in place
for paste-text flow, will be extended for PDF flow. Estimated **2–3 days**.

---

## Architectural Discovery (Important)

The party-mode plan assumed bk and Mandir were currently disjoint. **They
are not.** Reading bk-syllabus-hub commit `bbdefa2` and the existing
`/api/tools/transliterator/route.ts`:

1. **bk already submits to Mandir's Firestore** via `firestore-admin` server-side.
   The `transliterationJobs` collection is the shared queue. Worker
   doesn't care which app submitted — it just polls.
2. **Auth on bk side is NextAuth + role check** (`getSession`, `getUserRole`,
   `hasRole(role, 'WRITE')`). Server-side Firestore admin SDK bypasses
   Firestore rules entirely. No client Firebase Auth needed for bk's flow.
3. **The uid namespace is** `syllabus-hub:${email}` (when bk submits) vs the
   Firebase Auth uid (when Mandir/web standalone submits). Different
   identity spaces; both valid; no collision.
4. **bk's `<AsyncTransformClient />`** polls bk's own `/api/tools/transliterator/jobs/[id]`
   route, which reads from Firestore admin server-side. The browser never
   touches Firebase directly.
5. **bk's UI is paste-text only.** PDF upload, page-by-page OCR, live
   two-pane streaming, status chips — all absent. This is the gap.

This collapses the planned auth bridge, monorepo, pnpm workspace, and
git subtree work down to **UI + one new API route**.

---

## Current State

### bk-syllabus-hub
- `src/app/tools/transliterator/page.tsx` — server component, NextAuth-gated, renders `<AsyncTransformClient />`
- `src/app/api/tools/transliterator/route.ts` — POST writes paste-text job to `transliterationJobs`
- `src/app/api/tools/transliterator/jobs/[id]/route.ts` — GET polls a job by id
- `src/components/translator/AsyncTransformClient.tsx` — generic input/output polling component
- `src/lib/firestore-admin.ts` — admin SDK client for Mandir's Firebase project
- `src/lib/auth.ts` — NextAuth helpers (`getSession`, `getUserRole`, `hasRole`)

### Mandir/web (standalone)
- `app/page.tsx` — upload entry (PDF + paste-text)
- `app/transliterate/[jobId]/page.tsx` — live two-pane + chip rail (separate route from upload — Jay wants this folded into the upload flow)
- `app/admin/page.tsx` — admin observation portal (separate route)
- `app/api/upload/route.ts` — creates `transliterationJobs` doc + page subdocs from PDF
- `lib/firebase.ts` — client SDK with Firebase Auth (for standalone-Mandir users)
- `scripts/local-worker.mjs` — polls Firestore, OCRs each page via `pdftoppm` + Claude vision SDK, transliterates per page

### Shared
- **One Firebase project** (`aksharpith-translator`)
- **One Firestore schema** (`transliterationJobs/{jobId}/pages/{0001..N}`)
- **One worker** (Mandir/web/scripts/local-worker.mjs)

---

## Target State

### Unified `<BookCanvas />` component

Single React component, lives in **both** bk and Mandir/web (initially via copy;
later via shared package if duplication becomes painful). Three regions:

```
┌──────────────────────────────────────────────────────┐
│  [drop zone — collapses to slim ribbon when loaded]  │
├──────────────────────────────────────────────────────┤
│  ┌──── page 1 ────────────────────────────────────┐  │
│  │  [Gujarati column]    │  [Roman column]        │  │
│  │  ◯ chip: ocr_running  │  ◯ chip: queued        │  │
│  └────────────────────────────────────────────────┘  │
│  ┌──── page 2 ────────────────────────────────────┐  │
│  │  ...                                            │  │
│  └────────────────────────────────────────────────┘  │
│  ...                                                 │
└──────────────────────────────────────────────────────┘
```

- Upload zone collapses up into a slim ribbon (`+ new book`) once a job is loaded.
- Pages stream in below as the worker completes them. Each page card has its own
  status chip (queued / OCR'ing / done / failed).
- Transliteration text fades in below the Gujarati column when the per-page
  transliteration completes (`tw-animate-css` for the fade).
- No separate `/transliterate/[jobId]` route. URL becomes `/?book=<id>`
  (standalone) or `/tools/transliterator?book=<id>` (bk).

### Admin

- bk: gated behind `hasRole(role, 'ADMIN')`, renders the admin observation
  view inline as a Cmd-K drawer (no separate route).
- Mandir/web standalone: same Cmd-K drawer, gated by Firebase Auth admin
  custom claim.

### Design tokens

Adopt bk's `globals.css` token system:

- **Primary accent**: `--bk-orange: #ff6f00` (and hover `#e65f00`).
- **Mandir-content accent (proposed)**: `--mandir-saffron` for Gujarati page chips
  and verse highlights only — gives Mandir-content a distinct warm register
  inside the bk shell. *(Pending Jay's yes/no.)*
- **Type**: Inter (sans), Geist Mono, Noto Serif Gujarati (new — added via `next/font`).
- **Colour palette**: bk's OKLCH neutrals — `oklch(0.985 0 0)` background, `oklch(0.145 0 0)` foreground, etc. Replace Mandir's bespoke `bg-stone-200`/`bg-emerald-200` etc with semantic tokens (`bg-muted`, `bg-primary`, `bg-destructive`).
- **Motion**: `tw-animate-css` for fade/slide animations on page cards arriving.

---

## Work Plan

### Phase 1 — bk-side PDF upload (1 day)

**Goal**: bk's `/tools/transliterator` accepts PDF upload, creates the same `transliterationJobs` doc + page subdocs that Mandir/web's `/api/upload` does today.

- New route: `bk/src/app/api/tools/transliterator/upload-pdf/route.ts` — copy
  the relevant logic from `Mandir/web/app/api/upload/route.ts` but use
  bk's `firestore-admin` and `syllabus-hub:${email}` uid namespace.
- New route: `bk/src/app/api/tools/transliterator/blob-token/route.ts` —
  Vercel Blob upload-token handshake (same as Mandir's `/api/blob-token`).
- bk gets `@vercel/blob`, `pdf-lib` deps (for splitting + page counting).
- Worker: zero changes. It already polls `transliterationJobs` regardless of who created the job.

**QA gate**: PDF uploaded via bk → Mandir worker picks it up → pages appear in Firestore → bk's existing poll route returns the parent doc state. Verify with curl + Firebase console.

### Phase 2 — `<BookCanvas />` component in bk (1–1.5 days)

**Goal**: replace bk's paste-text-only `<AsyncTransformClient />` on `/tools/transliterator` with the unified pipeline-canvas.

- New file: `bk/src/components/transliterator/BookCanvas.tsx`. Client component.
- Polls `/api/tools/transliterator/jobs/[id]` for parent state and a new
  `/api/tools/transliterator/jobs/[id]/pages` endpoint for page-level state.
- Renders upload zone, ribbon, page cards, two-pane layout, status chips.
- Uses bk's existing `<Button>`, `<Card>` from shadcn-ui.
- Add Noto Serif Gujarati via `next/font/google` in `bk/src/app/layout.tsx`.

**QA gate**: end-to-end test with a real Gujarati PDF. Verify page chips
update live, transliteration appears below each page when worker completes,
no console errors, no flickering, accessibility (keyboard navigation works,
screen reader can read both columns).

### Phase 3 — port the redesign to Mandir/web standalone (0.5–1 day)

**Goal**: Mandir/web standalone gets the same `<BookCanvas />` UI, replacing the current `app/transliterate/[jobId]/page.tsx` and folding upload into the home page.

- Copy `BookCanvas.tsx` from bk to `Mandir/web/components/transliterator/BookCanvas.tsx`.
- Adapt the polling — Mandir uses Firebase client SDK `onSnapshot` (live), not bk's polling.
  This is the one component delta between the two hosts. Refactor the data layer
  into a `useBookJob(jobId)` hook with two implementations (one per host); the
  rendering layer is identical.
- Wire `Mandir/web/app/page.tsx` to render `<BookCanvas />`.
- Add a redirect in `Mandir/web/app/transliterate/[jobId]/page.tsx` → `/?book=<jobId>` for backwards-compatible permalinks.
- Adopt bk's design tokens by mirroring `globals.css` (Tailwind v4 migration — Mandir is currently on v3).

**QA gate**: standalone Mandir at the existing URL still works, looks like the bk version, no regressions on existing job data. Both URLs (`/?book=<id>` and old `/transliterate/<id>`) resolve to the same canvas.

### Phase 4 — admin Cmd-K drawer (0.25 day)

**Goal**: replace the `/admin` route in both apps with an inline drawer, keyboard-shortcut activated.

- New: `<AdminDrawer />` component in `bk/src/components/transliterator/`.
- Mounted globally in bk's layout when `hasRole(role, 'ADMIN')`.
- Cmd-K opens the drawer; lists active and recent `transliterationJobs` across all uids.
- Mandir/web standalone gets the same drawer, gated by the Firebase Auth admin custom claim.
- Delete `Mandir/web/app/admin/page.tsx` and `bk/src/app/admin/page.tsx` (the latter only if it's solely the transliterator admin — check first).

**QA gate**: Cmd-K opens, Cmd-K closes, lists jobs, navigates to a job, no leaks.

### Phase 5 — cleanup + cutover (0.25 day)

- Delete `Mandir/web/app/transliterate/[jobId]/page.tsx` (after redirect proven).
- Delete bk's `<AsyncTransformClient />` if no other tools use it (translator might still — check). If still used by `/tools/translator`, keep.
- Update `web/ARCHITECTURE.md` to reflect new structure.
- Update `bk/CLAUDE.md` and `Mandir/CLAUDE.md` with the new component locations.

**QA gate**: `npm run build` clean on both. No dead routes. No 404s on the existing standalone Mandir URL.

---

## Estimated Effort

| Phase | Time | Risk |
|-------|------|------|
| 1. bk-side PDF upload | 1 day | low |
| 2. `<BookCanvas />` in bk | 1–1.5 days | medium (UX polish) |
| 3. Port to Mandir/web standalone | 0.5–1 day | low |
| 4. Admin drawer | 0.25 day | low |
| 5. Cleanup | 0.25 day | low |
| **Total** | **3–4 days** | — |

**First demoable slice**: Phase 1 + Phase 2 = **2–2.5 days**. After that,
Jay can drop a PDF into bk's `/tools/transliterator` and see the redesign live.

---

## Safety Mandate (Jay's Rule)

> "Make sure you obsessively fix this and make sure NOTHING breaks."

### Pre-flight checks before each phase

- [ ] Mandir/web worker still running (PID matches, log shows recent activity).
- [ ] Mandir/web on origin/main, no uncommitted code on main.
- [ ] bk-syllabus-hub on origin/main, no uncommitted code on main (Jay's pack-blocks work is on a feature branch or untracked, leave alone).
- [ ] Existing standalone Mandir URL HTTP 200, can render an existing job.
- [ ] Existing bk `/tools/transliterator` HTTP 200, paste-text submission still works.

### Per-phase rules

- One feature branch per phase.
- Atomic conventional commits (`feat(transliterator): ...`).
- No edits to `Mandir/web` main during phases 1–2 (bk-only work).
- No edits to bk main during phase 3.
- Worker process not restarted unless absolutely necessary; if needed, do it during a quiet Firestore window.
- Tests written for the new API routes before they're consumed by UI.

### Rollback strategy

- Each phase = one branch. `git checkout main` restores the world.
- The standalone Mandir Vercel deployment stays on its current commit until Phase 3 is verified end-to-end. We don't promote phase 3 to Mandir's main until phase 2 is in production on bk.
- The Firebase project is shared; we never delete docs. Old `transliterationJobs` continue to render via the new UI (the schema is unchanged).

---

## Open Questions for Jay

- [ ] **Q3 (was open in party mode)**: Sally's saffron secondary token — yes/no? Default proposed: `--mandir-saffron: oklch(0.78 0.15 65)` for Gujarati page chips and verse highlights only.
- [ ] **Tailwind migration**: Mandir/web is on Tailwind v3, bk is on v4. Migrating Mandir to v4 is part of phase 3. Acceptable? Alternative: keep Mandir on v3 and inline-port only the colour tokens. (v4 migration cleaner long-term.)
- [ ] **Auth on Mandir/web standalone**: keep Firebase Auth (current), or also add NextAuth so the two apps share session shape? Recommendation: **keep Firebase Auth on standalone for now** — it works and the user pool is just Jay. Migrate to shared NextAuth only when there are real users to deduplicate.
- [ ] **Branch naming convention**: should I use `feat/aksharpith-*` for both repos, or app-scoped names?

---

## Decisions Log (from party mode, retained where still applicable)

| # | Decision | Rationale | Status |
|---|----------|-----------|--------|
| 01 | Packaging: ~~pnpm workspace~~ → **just copy `<BookCanvas />` between repos initially** | bk already has the integration; no need for a shared package until duplication becomes painful | revised |
| 02 | Routes: delete `/transliterate/[jobId]`, unified `/?book=<id>` | one canvas | accepted |
| 03 | Admin: Cmd-K drawer, no route | progressive disclosure | accepted |
| 04 | Worker: stays in `Mandir/web/scripts/`, not packaged | reads `.env.local` OAuth token | accepted |
| 05 | Design tokens: bk's `globals.css` is canon | already production-tested | accepted |
| 06 | Vertical slice: Phase 1 + Phase 2 = first demo | shippable in 2–2.5 days | accepted |
| 07 | Auth: ~~NextAuth replaces Firebase Auth on Mandir/web~~ → **bk uses NextAuth (already does), Mandir/web keeps Firebase Auth for now** | bk's flow needs no client Firebase; Mandir's flow uses live `onSnapshot` which needs Firebase Auth | revised |
| 08 | Firebase: one shared project | already true | accepted |
| 09 | Brand: bk-orange primary, mandir-saffron secondary for Gujarati surfaces | warm dual register | proposed, awaiting Jay |
| 10 | Migration safety: parallel deploys, rollback discipline | Jay's mandate | accepted |
| 11 | Git: ~~bk-syllabus-hub becomes monorepo via subtree~~ → **two repos stay separate; copy components between them** | revised plan doesn't need a monorepo | revised |
| 12 | Branch discipline: one feature branch per phase | atomic | accepted |
| 13 | Visual continuity: existing standalone URL must not degrade during build | Sally's mandate | accepted |

---

## Next Steps (when Jay confirms)

1. Answer open questions above (saffron y/n, Tailwind v4 migration y/n, branch naming).
2. Begin **Phase 1** on a fresh `feat/transliterator-pdf-upload` branch in `bk-syllabus-hub` (after Jay commits or stashes the existing pack-blocks work).
3. QA-gate after every commit. Worker uptime SLA: zero unplanned restarts during the build.

---

*Authored: 2026-05-03. Generated by /bmad-party-mode synthesis with post-discovery revision. Co-Authored-By: Claude Opus 4.7 (1M context).*
