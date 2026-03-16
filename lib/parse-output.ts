import type { OutputSection } from './rules/types';

/**
 * Detects if a block of text is a verse (transliterated text with poetic structure).
 * Verses typically contain diacritical marks, are wrapped in curly quotes,
 * or have short lines of similar length.
 */
function isVerseLike(block: string): boolean {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 1) return false;

  // Check for curly-quoted transliteration
  const hasCurlyQuotedVerse = lines.some(l => /^[\u201c\u201d]/.test(l) && /[āīūṛṅñṭḍṇśṣḥ]/.test(l));
  if (hasCurlyQuotedVerse) return true;

  // Check for italic markers (common in assembled output)
  const hasItalicVerse = lines.some(l => /^_.*_$/.test(l) || /^\*.*\*$/.test(l));
  if (hasItalicVerse) return true;

  // Multiple short lines with transliteration characters
  if (lines.length >= 2) {
    const diacriticLines = lines.filter(l => /[āīūṛṅñṭḍṇśṣḥ]/.test(l) || /[\u201c\u201d]/.test(l)).length;
    if (diacriticLines >= lines.length * 0.5) return true;

    // Short lines of similar length (poetic stanza structure)
    const avgLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
    if (avgLen < 80 && lines.every(l => Math.abs(l.length - avgLen) < avgLen * 0.6)) return true;
  }

  // Lines starting with quotes containing transliteration
  if (lines.some(l => /^[\u201c"']/.test(l) && lines.some(l2 => /[āīūṛṅñṭḍṇśṣḥ]/.test(l2)))) return true;

  return false;
}

/**
 * Extracts transliteration and meaning from a verse block.
 * Pattern: transliteration line(s) followed by parenthesized meaning.
 */
function parseVerseDetails(content: string): { transliteration?: string; meaning?: string } {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const translitLines: string[] = [];
  let meaning: string | undefined;

  for (const line of lines) {
    // Lines with parenthesized meaning
    const meaningMatch = line.match(/^\((.+)\)$/);
    if (meaningMatch) {
      meaning = meaningMatch[1];
      continue;
    }
    // Transliteration lines (contain diacritics or are in curly quotes)
    if (/[āīūṛṅñṭḍṇśṣḥ]/.test(line) || /^[\u201c\u201d]/.test(line)) {
      translitLines.push(line);
    }
  }

  return {
    transliteration: translitLines.length > 0 ? translitLines.join('\n') : undefined,
    meaning,
  };
}

/**
 * Parses pipeline output text into structured sections of prose and verse.
 */
export function parseOutputSections(text: string): OutputSection[] {
  if (!text || !text.trim()) return [];

  // Split on double newlines to get blocks
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
  const sections: OutputSection[] = [];
  let index = 0;

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (isVerseLike(trimmed)) {
      const { transliteration, meaning } = parseVerseDetails(trimmed);
      sections.push({
        type: 'verse',
        content: trimmed,
        transliteration,
        meaning,
        index: index++,
      });
    } else {
      sections.push({
        type: 'prose',
        content: trimmed,
        index: index++,
      });
    }
  }

  return sections;
}
