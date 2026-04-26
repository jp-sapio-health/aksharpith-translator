import { describe, it, expect } from 'vitest';
import {
  TERMINOLOGY_RULES,
  PERSONAL_NAME_RULES,
  PLACE_NAME_RULES,
  FORBIDDEN_VOCAB_RULES,
  HEDGING_RULES,
  DATE_FORMAT_RULES,
  DIACRITICS_MAP,
} from '../terminology';
import { FORBIDDEN_VOCABULARY } from '../forbidden-vocab';
import { PROTECTED_TERMS_LIST, PROTECTED_TERMS } from '../protected-terms';
import type { TerminologyRule } from '../types';

// Apply a single rule the same way the enforcer does.
function applyRule(text: string, rule: TerminologyRule): string {
  return text.replace(rule.pattern, rule.replacement as never);
}

// Apply a list of rules in order.
function applyRules(text: string, rules: TerminologyRule[]): string {
  return rules.reduce(applyRule, text);
}

// Derive a literal trigger string from a simple word-boundary regex.
// Returns null when the pattern uses alternation, groups, or anchors we can't safely synthesise.
function triggerFor(pattern: RegExp): string | null {
  const src = pattern.source;
  const stripped = src.replace(/^\\b/, '').replace(/\\b$/, '');
  if (/[()|\[\]?+*$^]/.test(stripped)) return null;
  // Allow letters, spaces, hyphens, apostrophes, and the diacritic glyphs in our rule set.
  if (/^[A-Za-z\s'\-’]+$/.test(stripped)) return stripped;
  return null;
}

// ---------- Rule-list shape invariants ----------

describe('rule list lengths (regression guard)', () => {
  it('TERMINOLOGY_RULES has 33 rules', () => {
    expect(TERMINOLOGY_RULES).toHaveLength(33);
  });
  it('PERSONAL_NAME_RULES has 3 rules', () => {
    expect(PERSONAL_NAME_RULES).toHaveLength(3);
  });
  it('PLACE_NAME_RULES has 9 rules', () => {
    expect(PLACE_NAME_RULES).toHaveLength(9);
  });
  it('FORBIDDEN_VOCAB_RULES has 11 rules', () => {
    expect(FORBIDDEN_VOCAB_RULES).toHaveLength(11);
  });
  it('HEDGING_RULES has 7 rules', () => {
    expect(HEDGING_RULES).toHaveLength(7);
  });
  it('DATE_FORMAT_RULES has 1 rule', () => {
    expect(DATE_FORMAT_RULES).toHaveLength(1);
  });
  it('DIACRITICS_MAP has 12 entries', () => {
    expect(Object.keys(DIACRITICS_MAP)).toHaveLength(12);
  });
});

describe('every rule has a non-empty rule label', () => {
  const all = [
    ...TERMINOLOGY_RULES,
    ...PERSONAL_NAME_RULES,
    ...PLACE_NAME_RULES,
    ...FORBIDDEN_VOCAB_RULES,
    ...HEDGING_RULES,
    ...DATE_FORMAT_RULES,
  ];
  it.each(all)('label exists: $rule', (r) => {
    expect(typeof r.rule).toBe('string');
    expect(r.rule.length).toBeGreaterThan(0);
  });
});

// ---------- Per-rule firing tests ----------

function describeRuleList(name: string, rules: TerminologyRule[]) {
  describe(`${name} fires on a synthetic trigger`, () => {
    rules.forEach((rule, idx) => {
      const trigger = triggerFor(rule.pattern);
      if (!trigger) {
        // Patterns with alternation / groups are tested elsewhere.
        return;
      }
      it(`[${idx}] "${rule.rule}" replaces a literal trigger`, () => {
        const before = `intro ${trigger} outro`;
        const after = applyRule(before, rule);
        expect(after).not.toBe(before);
      });
    });
  });
}

describeRuleList('TERMINOLOGY_RULES', TERMINOLOGY_RULES);
describeRuleList('PERSONAL_NAME_RULES', PERSONAL_NAME_RULES);
describeRuleList('PLACE_NAME_RULES', PLACE_NAME_RULES);
describeRuleList('FORBIDDEN_VOCAB_RULES', FORBIDDEN_VOCAB_RULES);
describeRuleList('HEDGING_RULES', HEDGING_RULES);

// ---------- Hand-picked correctness tests ----------

describe('TERMINOLOGY_RULES correctness — golden cases', () => {
  it('saint → swami, Saint → Swami (case preserved)', () => {
    expect(applyRules('the saint walked', TERMINOLOGY_RULES)).toContain('swami');
    expect(applyRules('the Saint walked', TERMINOLOGY_RULES)).toContain('Swami');
  });
  it('saints → swamis, Saints → Swamis', () => {
    expect(applyRules('the saints gathered', TERMINOLOGY_RULES)).toContain('swamis');
    expect(applyRules('the Saints gathered', TERMINOLOGY_RULES)).toContain('Swamis');
  });
  it('temple → mandir, Temple → Mandir', () => {
    expect(applyRules('a temple here', TERMINOLOGY_RULES)).toContain('mandir');
    expect(applyRules('a Temple here', TERMINOLOGY_RULES)).toContain('Mandir');
  });
  it('aarti → arti', () => {
    expect(applyRules('aarti time', TERMINOLOGY_RULES)).toContain('arti');
  });
  it('Lord Swaminarayan → Bhagwan Swaminarayan (case sensitive)', () => {
    expect(applyRules('Lord Swaminarayan said', TERMINOLOGY_RULES)).toContain('Bhagwan Swaminarayan');
  });
  it('Hindu mythology → Hindu sacred history', () => {
    expect(applyRules('Hindu mythology tells', TERMINOLOGY_RULES)).toContain('Hindu sacred history');
  });
  it('mythology → sacred history', () => {
    expect(applyRules('Greek mythology', TERMINOLOGY_RULES)).toContain('sacred history');
  });
  it('sadhus → swamis (BAPS context)', () => {
    expect(applyRules('the sadhus walked', TERMINOLOGY_RULES)).toContain('swamis');
  });
  it('sannyasis → bawas (impostors)', () => {
    expect(applyRules('the sannyasis arrived', TERMINOLOGY_RULES)).toContain('bawas');
  });
  it('avataric Purush → avatari Purush', () => {
    expect(applyRules('avataric Purush', TERMINOLOGY_RULES)).toContain('avatari Purush');
  });
  it('does not over-match: word-boundary protects "monkey"', () => {
    expect(applyRules('the monkey jumped', TERMINOLOGY_RULES)).toContain('monkey');
  });
});

describe('PLACE_NAME_RULES correctness', () => {
  it('Pipalana → Piplana (case sensitive)', () => {
    expect(applyRules('born in Pipalana', PLACE_NAME_RULES)).toContain('Piplana');
  });
  it('Mumbai Province → Bombay Province (era-correct)', () => {
    expect(applyRules('the Mumbai Province', PLACE_NAME_RULES)).toContain('Bombay Province');
  });
  it('Saurashtra → Kathiawad (era-correct)', () => {
    expect(applyRules('travelled to Saurashtra', PLACE_NAME_RULES)).toContain('Kathiawad');
  });
});

describe('PERSONAL_NAME_RULES correctness', () => {
  it('Bhilalbhai → Bhailalbhai', () => {
    expect(applyRules('met Bhilalbhai today', PERSONAL_NAME_RULES)).toContain('Bhailalbhai');
  });
  it('Narayanda → Naran’da', () => {
    expect(applyRules('Narayanda spoke', PERSONAL_NAME_RULES)).toContain('Naran’da');
  });
});

describe('HEDGING_RULES correctness', () => {
  it('removes "perhaps"', () => {
    expect(applyRules('he perhaps came', HEDGING_RULES)).not.toContain('perhaps');
  });
  it('removes "It is believed that"', () => {
    expect(applyRules('It is believed that he came', HEDGING_RULES)).not.toContain('believed that');
  });
});

describe('DATE_FORMAT_RULES correctness', () => {
  it('American → British: January 5, 1837 → 5 January 1837', () => {
    const out = applyRule('on January 5, 1837 the event', DATE_FORMAT_RULES[0]);
    expect(out).toContain('5 January 1837');
  });
  it('handles double-digit day', () => {
    const out = applyRule('December 25, 1999 came', DATE_FORMAT_RULES[0]);
    expect(out).toContain('25 December 1999');
  });
});

// ---------- DIACRITICS_MAP correctness ----------

describe('DIACRITICS_MAP', () => {
  const expected: Array<[string, string]> = [
    ['ṁ', 'm'],
    ['ṭ', 't'],
    ['ṣ', 'sh'],
    ['ś', 'sh'],
    ['ṇ', 'n'],
    ['ī', 'i'],
    ['ū', 'u'],
    ['ṛ', 'r'],
    ['ṅ', 'n'],
    ['ḍ', 'd'],
    ['ħ', 'h'],
    ['ñ', 'n'],
  ];
  it.each(expected)('maps %s → %s', (k, v) => {
    expect(DIACRITICS_MAP[k]).toBe(v);
  });
  it('does not contain ā (macron-a is the only allowed diacritic)', () => {
    expect(DIACRITICS_MAP['ā']).toBeUndefined();
  });
});

// ---------- FORBIDDEN_VOCABULARY invariants ----------

describe('FORBIDDEN_VOCABULARY', () => {
  it('has the expected length', () => {
    // Sant-curated count of advisory forbidden terms.
    expect(FORBIDDEN_VOCABULARY).toHaveLength(50);
  });
  it('contains no empty strings', () => {
    FORBIDDEN_VOCABULARY.forEach((t) => expect(t.trim().length).toBeGreaterThan(0));
  });
  it('contains no duplicates', () => {
    expect(new Set(FORBIDDEN_VOCABULARY).size).toBe(FORBIDDEN_VOCABULARY.length);
  });
  it('contains key sentinel terms', () => {
    expect(FORBIDDEN_VOCABULARY).toContain('mythology');
    expect(FORBIDDEN_VOCABULARY).toContain('charismatic');
    expect(FORBIDDEN_VOCABULARY).toContain('stakeholder');
    expect(FORBIDDEN_VOCABULARY).toContain('innovation');
    expect(FORBIDDEN_VOCABULARY).toContain('story');
  });
  it('all entries are lowercase or contain a space', () => {
    FORBIDDEN_VOCABULARY.forEach((t) => {
      const wordsOnly = t.replace(/\s/g, '');
      expect(wordsOnly).toBe(wordsOnly.toLowerCase());
    });
  });
});

// ---------- PROTECTED_TERMS invariants ----------

describe('PROTECTED_TERMS_LIST', () => {
  it('has the expected length', () => {
    expect(PROTECTED_TERMS_LIST).toHaveLength(20);
  });
  it('contains no empty strings', () => {
    PROTECTED_TERMS_LIST.forEach((t) => expect(t.trim().length).toBeGreaterThan(0));
  });
  it('contains no duplicates', () => {
    expect(new Set(PROTECTED_TERMS_LIST).size).toBe(PROTECTED_TERMS_LIST.length);
  });
  it('contains key sentinel terms', () => {
    expect(PROTECTED_TERMS_LIST).toContain('mandir');
    expect(PROTECTED_TERMS_LIST).toContain('satsang');
    expect(PROTECTED_TERMS_LIST).toContain('Akshardham');
    expect(PROTECTED_TERMS_LIST).toContain('vachanamrut');
    expect(PROTECTED_TERMS_LIST).toContain('paramhansa');
  });
  it('PROTECTED_TERMS string concatenation matches list', () => {
    expect(PROTECTED_TERMS).toBe(PROTECTED_TERMS_LIST.join(', '));
  });
});

// ---------- Cross-cutting: protected terms survive rule pass ----------

describe('protected terms survive a full terminology pass', () => {
  const allRules = [
    ...TERMINOLOGY_RULES,
    ...PERSONAL_NAME_RULES,
    ...PLACE_NAME_RULES,
    ...FORBIDDEN_VOCAB_RULES,
    ...HEDGING_RULES,
  ];
  PROTECTED_TERMS_LIST.forEach((term) => {
    it(`"${term}" is not modified by terminology rules`, () => {
      const sentence = `the ${term} is sacred`;
      const out = applyRules(sentence, allRules);
      expect(out).toContain(term);
    });
  });
});
