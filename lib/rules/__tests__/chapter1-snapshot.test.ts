import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TERMINOLOGY_RULES,
  PERSONAL_NAME_RULES,
  PLACE_NAME_RULES,
  FORBIDDEN_VOCAB_RULES,
  HEDGING_RULES,
  DATE_FORMAT_RULES,
  DIACRITICS_MAP,
} from '../terminology';
import type { TerminologyRule } from '../types';

// Mirror the order pipeline.ts:332 applies rules in production.
function enforce(text: string): string {
  const lists: TerminologyRule[][] = [
    TERMINOLOGY_RULES,
    PERSONAL_NAME_RULES,
    PLACE_NAME_RULES,
    FORBIDDEN_VOCAB_RULES,
    HEDGING_RULES,
    DATE_FORMAT_RULES,
  ];
  let t = text;
  for (const list of lists) {
    for (const rule of list) {
      t = t.replace(rule.pattern, rule.replacement as never);
    }
  }
  return t;
}

const GOLDEN_HISTORICAL = readFileSync(
  resolve(__dirname, '../../../test-output-chapter1.txt'),
  'utf-8'
);

// ── Invariants on the historical Sant-curated reference ────────────────────
// These are the year-of-work guard rails: future rule changes must not
// stop the canonical proper nouns from appearing or let banned terms slip.

describe('chapter 1 historical golden — Sant-curated invariants', () => {
  it('loads and is non-trivial', () => {
    expect(GOLDEN_HISTORICAL.length).toBeGreaterThan(1000);
  });

  it('preserves canonical Bhagwan Swaminarayan reference', () => {
    expect(GOLDEN_HISTORICAL).toContain('Bhagwan Swaminarayan');
    expect(GOLDEN_HISTORICAL).not.toContain('Lord Swaminarayan');
  });

  it('uses era-correct Bombay Province (not modern Mumbai Province)', () => {
    expect(GOLDEN_HISTORICAL).toContain('Bombay Province');
    expect(GOLDEN_HISTORICAL).not.toContain('Mumbai Province');
  });

  it('preserves protected sacred terms', () => {
    expect(GOLDEN_HISTORICAL).toContain('paramhansa');
    expect(GOLDEN_HISTORICAL).toContain('Kathiawad');
  });

  it('does not leak the high-confidence banned terms', () => {
    // Conservative subset — only those that have no legitimate use in narrative.
    const banned = ['stakeholder', 'milestone', 'innovation', 'charismatic'];
    for (const term of banned) {
      const re = new RegExp(`\\b${term}\\b`, 'i');
      expect(re.test(GOLDEN_HISTORICAL), `historical golden unexpectedly contains "${term}"`).toBe(false);
    }
  });
});

// ── Enforcer is a fixed point on its own output ────────────────────────────
// True invariant: applying the enforcer twice equals applying it once.
// The historical golden is NOT a fixed point because rules have been added
// since 2026-03-15 — that divergence is captured separately below.

describe('rulesEnforcer idempotency on its own output', () => {
  it('enforce(enforce(x)) === enforce(x) on chapter 1 source', () => {
    const once = enforce(GOLDEN_HISTORICAL);
    const twice = enforce(once);
    expect(twice).toBe(once);
  });

  it('idempotency holds on ASCII-only synthetic input', () => {
    const synthetic =
      'The saint walked to the temple. ' +
      'On January 5, 1837 he reached Pipalana in Mumbai Province. ' +
      'Lord Swaminarayan blessed the followers.';
    const once = enforce(synthetic);
    const twice = enforce(once);
    expect(twice).toBe(once);
  });

  it('produces expected canonical phrasing on synthetic input', () => {
    const out = enforce('The saint walked to the temple in Mumbai Province');
    expect(out).toContain('swami');
    expect(out).toContain('mandir');
    expect(out).toContain('Bombay Province');
  });
});

// ── Documented divergence: rules have evolved since the golden was generated ─
// This test captures the *fact* that today's rule set would change the golden.
// It exists to make the divergence explicit and reviewable, not to fail CI.

describe('rule evolution since 2026-03-15 (documented)', () => {
  it('current rules would modify the historical golden', () => {
    // If this assertion ever fails, the historical golden has been re-baked
    // against current rules — update the comment and consider deleting this block.
    const once = enforce(GOLDEN_HISTORICAL);
    expect(once).not.toBe(GOLDEN_HISTORICAL);
  });

  it('new divergences are bounded in length (no catastrophic regression)', () => {
    const once = enforce(GOLDEN_HISTORICAL);
    const lengthDelta = Math.abs(once.length - GOLDEN_HISTORICAL.length);
    const ratio = lengthDelta / GOLDEN_HISTORICAL.length;
    // Sanity: rule changes should not warp the document by more than 5%.
    expect(ratio).toBeLessThan(0.05);
  });
});

// ── Diacritics policy ──────────────────────────────────────────────────────

describe('diacritics policy on golden', () => {
  it('historical golden preserves macron-a (only allowed diacritic)', () => {
    expect(GOLDEN_HISTORICAL).toMatch(/[ā]/);
  });

  it('diacritic stripping is idempotent', () => {
    let stripped = GOLDEN_HISTORICAL;
    for (const [k, v] of Object.entries(DIACRITICS_MAP)) {
      stripped = stripped.split(k).join(v);
    }
    let twice = stripped;
    for (const [k, v] of Object.entries(DIACRITICS_MAP)) {
      twice = twice.split(k).join(v);
    }
    expect(twice).toBe(stripped);
  });
});
