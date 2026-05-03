import { describe, it, expect } from 'vitest';
import { parseTransliterator, ParserError } from '../parser';
import { rulesEnforcerAgent } from '../pipeline';

describe('parseTransliterator', () => {
  it('parses a happy-path block', () => {
    const raw = `<transliteration>
Shriji Mahārāj gadhadāmān birājtā hatā.
</transliteration>`;
    const out = parseTransliterator(raw);
    expect(out.transliteration).toBe('Shriji Mahārāj gadhadāmān birājtā hatā.');
  });

  it('preserves <verse>…</verse> markup verbatim for the renderer', () => {
    const raw = `<transliteration>
Prose paragraph one.

<verse>Premē pragatyā re sūraj sahajānand</verse>
<verse>Ātmā jāgo re</verse>

Prose paragraph two.
</transliteration>`;
    const out = parseTransliterator(raw).transliteration;
    expect(out).toContain('<verse>Premē pragatyā re sūraj sahajānand</verse>');
    expect(out).toContain('<verse>Ātmā jāgo re</verse>');
    expect(out).toContain('Prose paragraph one.');
  });

  it('strips an outer markdown code fence', () => {
    const raw = '```xml\n<transliteration>Bhagwān Swāminārāyan</transliteration>\n```';
    expect(parseTransliterator(raw).transliteration).toBe('Bhagwān Swāminārāyan');
  });

  it('throws ParserError on missing tags', () => {
    expect(() => parseTransliterator('no tags here')).toThrow(ParserError);
  });

  it('throws ParserError on empty block', () => {
    expect(() => parseTransliterator('<transliteration></transliteration>')).toThrow(ParserError);
  });

  it('throws ParserError on duplicate opening tags', () => {
    expect(() => parseTransliterator(
      '<transliteration>a</transliteration><transliteration>b</transliteration>'
    )).toThrow(ParserError);
  });

  it('throws ParserError with stage = transliterator', () => {
    try {
      parseTransliterator('<transliteration>');
    } catch (e) {
      expect(e).toBeInstanceOf(ParserError);
      if (e instanceof ParserError) expect(e.stage).toBe('transliterator');
    }
  });
});

// House Rules §2.2 — only ā is permitted; every other diacritic must be
// stripped before any output reaches the user. The enforcer runs after both
// transliterator and translator stages; if a model emits ī/ū/ṇ/ṭ/ṣ/ś/ṛ/ṅ/ḍ/ñ
// the enforcer must rewrite to plain Roman.
describe('rulesEnforcerAgent — ā-only diacritic rule', () => {
  it('preserves ā / Ā unchanged', () => {
    const out = rulesEnforcerAgent('Ātmā jāgo re — Bhagwān Swāminārāyan');
    expect(out.text).toContain('Ātmā');
    expect(out.text).toContain('jāgo');
    expect(out.text).toContain('Bhagwān');
  });

  it('strips ī to plain i', () => {
    const out = rulesEnforcerAgent('Shrīji Mahārāj');
    expect(out.text).not.toContain('ī');
    expect(out.text).toContain('Shriji');
  });

  it('strips ū to plain u', () => {
    const out = rulesEnforcerAgent('sūraj');
    expect(out.text).not.toContain('ū');
    expect(out.text).toContain('suraj');
  });

  it('strips retroflex ṇ ṭ ḍ to dental n t d', () => {
    const out = rulesEnforcerAgent('Pārabrahma sākshāt rūpa with ṇ, ṭ, ḍ');
    expect(out.text).not.toMatch(/[ṇṭḍ]/);
    expect(out.text).toContain('n');
    expect(out.text).toContain('t');
    expect(out.text).toContain('d');
  });

  it('strips sibilants ś / ṣ to sh', () => {
    const out = rulesEnforcerAgent('Ākśardhām Ākṣar');
    expect(out.text).not.toMatch(/[śṣ]/);
    expect(out.text.toLowerCase()).toContain('sh');
  });

  it('strips palatal ñ and velar ṅ to plain n', () => {
    const out = rulesEnforcerAgent('jñāna saṅgha');
    expect(out.text).not.toMatch(/[ñṅ]/);
  });

  it('strips vocalic ṛ', () => {
    // Canonical DIACRITICS_MAP currently maps ṛ → r (not ri per ISO 15919).
    // The transliterator-prompt's table prefers ri; the enforcer is the floor.
    // Either yields "no forbidden diacritic survives", which is the contract.
    const out = rulesEnforcerAgent('Kṛṣṇa');
    expect(out.text).not.toContain('ṛ');
  });

  // TODO(sant approval required): visarga ḥ (ḥ) is not in the canonical
  // DIACRITICS_MAP. The transliterator-prompt asks the model to emit `h`
  // directly; if it slips and emits ḥ, the enforcer currently leaves it.
  // Adding a one-line entry to lib/rules/terminology.ts would close the gap
  // but the rules file is sant-curated, so this stays as a documented bug
  // until approved.
  it.skip('strips visarga ḥ to plain h (canonical DIACRITICS_MAP gap)', () => {
    const out = rulesEnforcerAgent('namaḥ');
    expect(out.text).not.toContain('ḥ');
    expect(out.text).toContain('namah');
  });

  it('is idempotent — running twice equals running once', () => {
    const input = 'Bhagwān Swāminārāyan with ī ū ṇ';
    const once = rulesEnforcerAgent(input).text;
    const twice = rulesEnforcerAgent(once).text;
    expect(twice).toBe(once);
  });

  it('preserves ā even when other diacritics in the same string are stripped', () => {
    const out = rulesEnforcerAgent('Ātmā with stray ī and ū');
    expect(out.text).toContain('Ātmā');
    expect(out.text).not.toContain('ī');
    expect(out.text).not.toContain('ū');
  });

  it('reports diacritic substitutions in corrections', () => {
    const out = rulesEnforcerAgent('Shrīji Mahārāj sūraj');
    const stripped = out.corrections.find(c => c.rule.includes('forbidden diacritics'));
    expect(stripped).toBeDefined();
    expect(out.totalFixes).toBeGreaterThan(0);
  });
});
