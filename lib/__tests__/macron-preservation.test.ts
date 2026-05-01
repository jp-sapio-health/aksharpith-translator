import { describe, it, expect } from 'vitest';
import { preserveMacrons, rulesEnforcerAgent } from '../pipeline';

describe('rulesEnforcerAgent: macron-a (ā) preservation', () => {
  it('does not strip ā from prose', () => {
    const input = 'The verse says “Ātmā jāgo re”.';
    const { text } = rulesEnforcerAgent(input);
    expect(text).toContain('Ātmā');
    expect(text).toContain('jāgo');
  });

  it('strips other diacritics (ī, ū, ṇ, etc.) but preserves ā', () => {
    const input = 'prāṇī, sūtra, ṣaṭkona — and the verse “Ātmā jāgo”.';
    const { text } = rulesEnforcerAgent(input);
    // Forbidden diacritics gone:
    expect(text).not.toContain('ṇ');
    expect(text).not.toContain('ī');
    expect(text).not.toContain('ū');
    expect(text).not.toContain('ṣ');
    // ā preserved:
    expect(text).toContain('ā');
    expect(text).toContain('Ātmā');
  });

  it('counts ā occurrences correctly across the enforcer', () => {
    const input = 'ātmā jāgo bhakti ānand prāpti';
    const before = (input.match(/ā/g) ?? []).length;
    const { text } = rulesEnforcerAgent(input);
    const after = (text.match(/ā/g) ?? []).length;
    expect(after).toBe(before);
  });
});

describe('preserveMacrons', () => {
  it('returns input unchanged when translator emitted no ā', () => {
    const t = 'Plain prose. No macrons.';
    const s = 'Plain prose. No macrons.';
    const r = preserveMacrons(t, s);
    expect(r.restored).toBe(0);
    expect(r.text).toBe(s);
  });

  it('returns input unchanged when smoother preserved all macrons', () => {
    const t = 'The verse: “Ātmā jāgo re”.';
    const s = 'The verse — “Ātmā jāgo re”.';
    const r = preserveMacrons(t, s);
    expect(r.restored).toBe(0);
    expect(r.text).toBe(s);
  });

  it('restores a macron-stripped verse line from the translator output', () => {
    const t = 'Some prose.\n“Ātmā jāgo re”\nMore prose.';
    const s = 'Some prose.\n“Atma jago re”\nMore prose.';
    const r = preserveMacrons(t, s);
    expect(r.restored).toBe(3); // Ā, ā, ā
    expect(r.text).toContain('Ātmā jāgo re');
    expect(r.text).not.toContain('Atma jago re');
  });

  it('restores multiple verse lines independently', () => {
    const t = '“Pārabrahma”\nprose\n“Mukundā”';
    const s = '“Parabrahma”\nprose\n“Mukunda”';
    const r = preserveMacrons(t, s);
    expect(r.restored).toBe(2);
    expect(r.text).toContain('Pārabrahma');
    expect(r.text).toContain('Mukundā');
  });

  it('does not corrupt prose containing words that look like stripped verses', () => {
    // A word like "atma" appears in prose and should NOT be replaced with ātmā.
    const t = 'In prose we use atma.\n“Ātmā jāgo”';
    const s = 'In prose we use atma.\n“Atma jago”';
    const r = preserveMacrons(t, s);
    // Only the verse line is restored; prose "atma" stays plain.
    expect(r.text).toContain('In prose we use atma.');
    expect(r.text).toContain('Ātmā jāgo');
  });
});
