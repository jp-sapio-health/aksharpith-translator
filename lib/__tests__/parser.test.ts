import { describe, it, expect } from 'vitest';
import { parseTranslator, parseSmoother, ParserError } from '../parser';

describe('parseTranslator', () => {
  it('parses a happy-path response with translation and flags', () => {
    const raw = `<translation>
The Lord arrived at the village.
</translation>
<flags>
<flag>The phrase "પ્રેમે પ્રગટ્યા" rendered as "appeared with love" — verify register</flag>
</flags>`;
    const out = parseTranslator(raw);
    expect(out.translation).toBe('The Lord arrived at the village.');
    expect(out.flags).toEqual([
      'The phrase "પ્રેમે પ્રગટ્યા" rendered as "appeared with love" — verify register',
    ]);
  });

  it('tolerates leading and trailing whitespace', () => {
    const raw = `   \n\n<translation>Hello.</translation>\n<flags></flags>\n   `;
    const out = parseTranslator(raw);
    expect(out.translation).toBe('Hello.');
    expect(out.flags).toEqual([]);
  });

  it('strips an outer markdown code fence with a language tag', () => {
    const raw = '```xml\n<translation>Greetings.</translation>\n<flags></flags>\n```';
    const out = parseTranslator(raw);
    expect(out.translation).toBe('Greetings.');
    expect(out.flags).toEqual([]);
  });

  it('strips an outer markdown code fence without a language tag', () => {
    const raw = '```\n<translation>Greetings.</translation>\n<flags></flags>\n```';
    const out = parseTranslator(raw).translation;
    expect(raw).toBe(raw);
    expect(out).toBe('Greetings.');
  });

  it('preserves curly quotes, en dashes and verse blocks verbatim', () => {
    const verse = `“Preme pragatyā re suraj Sahajānand” – the verse opens.\n\nHe said, “I will not yield – not now, not ever.”`;
    const raw = `<translation>${verse}</translation>\n<flags></flags>`;
    const out = parseTranslator(raw);
    expect(out.translation).toBe(verse);
  });

  it('returns flags: [] for an empty <flags></flags> block', () => {
    const raw = `<translation>Body.</translation>\n<flags></flags>`;
    const out = parseTranslator(raw);
    expect(out.flags).toEqual([]);
  });

  it('returns flags: [] when <flags> contains only whitespace', () => {
    const raw = `<translation>Body.</translation>\n<flags>\n   \n</flags>`;
    const out = parseTranslator(raw);
    expect(out.flags).toEqual([]);
  });

  it('parses multiple <flag> entries and trims their content', () => {
    const raw = `<translation>Body.</translation>\n<flags>\n  <flag>  first  </flag>\n  <flag>second</flag>\n  <flag>third with – en dash</flag>\n</flags>`;
    const out = parseTranslator(raw);
    expect(out.flags).toEqual(['first', 'second', 'third with – en dash']);
  });

  it('skips empty <flag></flag> entries', () => {
    const raw = `<translation>Body.</translation>\n<flags>\n  <flag></flag>\n  <flag>kept</flag>\n  <flag>   </flag>\n</flags>`;
    const out = parseTranslator(raw);
    expect(out.flags).toEqual(['kept']);
  });

  it('throws when <translation> is missing', () => {
    const raw = `<flags></flags>`;
    expect(() => parseTranslator(raw)).toThrow(ParserError);
    try {
      parseTranslator(raw);
    } catch (e) {
      expect(e).toBeInstanceOf(ParserError);
      expect((e as ParserError).stage).toBe('translator');
      expect((e as ParserError).message).toMatch(/Missing <translation>/);
    }
  });

  it('throws when </translation> is missing (unclosed)', () => {
    const raw = `<translation>Body but no close\n<flags></flags>`;
    expect(() => parseTranslator(raw)).toThrow(/Missing <\/translation>/);
  });

  it('throws when <flags> is missing', () => {
    const raw = `<translation>Body.</translation>`;
    expect(() => parseTranslator(raw)).toThrow(/Missing <flags>/);
  });

  it('throws when <translation> appears twice', () => {
    const raw = `<translation>One.</translation>\n<translation>Two.</translation>\n<flags></flags>`;
    expect(() => parseTranslator(raw)).toThrow(/Multiple <translation>/);
  });

  it('throws when </translation> appears twice', () => {
    const raw = `<translation>Body.</translation>\nstray </translation>\n<flags></flags>`;
    expect(() => parseTranslator(raw)).toThrow(/Multiple <\/translation>/);
  });

  it('throws when <translation> is empty after trim', () => {
    const raw = `<translation>   \n   </translation>\n<flags></flags>`;
    expect(() => parseTranslator(raw)).toThrow(/Empty <translation>/);
  });

  it('throws on empty input', () => {
    expect(() => parseTranslator('')).toThrow(/Empty translator output/);
    expect(() => parseTranslator('   \n   ')).toThrow(/Empty translator output/);
  });

  it('throws on a non-string input', () => {
    expect(() => parseTranslator(undefined as unknown as string)).toThrow(ParserError);
    expect(() => parseTranslator(null as unknown as string)).toThrow(ParserError);
    expect(() => parseTranslator(42 as unknown as string)).toThrow(ParserError);
  });

  it('handles a translation containing nested quotation patterns', () => {
    const body = 'He said, “Swamishri replied, ‘Prapti is 24 hours.’”';
    const raw = `<translation>${body}</translation>\n<flags></flags>`;
    expect(parseTranslator(raw).translation).toBe(body);
  });
});

describe('parseSmoother', () => {
  it('parses a happy-path single <smoothed> block', () => {
    const raw = `<smoothed>The polished prose.</smoothed>`;
    expect(parseSmoother(raw).smoothed).toBe('The polished prose.');
  });

  it('strips an outer code fence and tolerates whitespace', () => {
    const raw = '```xml\n   <smoothed>Body.</smoothed>   \n```';
    expect(parseSmoother(raw).smoothed).toBe('Body.');
  });

  it('preserves verse, curly quotes and en dashes verbatim', () => {
    const body = `“Akshardham” – the highest abode. He said, “I shall remain – steadfast.”`;
    const raw = `<smoothed>${body}</smoothed>`;
    expect(parseSmoother(raw).smoothed).toBe(body);
  });

  it('throws when <smoothed> is missing', () => {
    expect(() => parseSmoother(`<translation>oops</translation>`)).toThrow(/Missing <smoothed>/);
  });

  it('throws when </smoothed> is missing', () => {
    expect(() => parseSmoother(`<smoothed>unterminated`)).toThrow(/Missing <\/smoothed>/);
  });

  it('throws when the <smoothed> block is empty', () => {
    expect(() => parseSmoother(`<smoothed></smoothed>`)).toThrow(/Empty <smoothed>/);
    expect(() => parseSmoother(`<smoothed>   \n   </smoothed>`)).toThrow(/Empty <smoothed>/);
  });

  it('throws when <smoothed> appears more than once', () => {
    const raw = `<smoothed>One.</smoothed>\n<smoothed>Two.</smoothed>`;
    expect(() => parseSmoother(raw)).toThrow(/Multiple <smoothed>/);
  });

  it('throws on empty / non-string input and tags the stage', () => {
    expect(() => parseSmoother('')).toThrow(/Empty smoother output/);
    try {
      parseSmoother('');
    } catch (e) {
      expect((e as ParserError).stage).toBe('smoother');
    }
  });
});
