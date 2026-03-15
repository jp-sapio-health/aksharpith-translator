import https from 'node:https';
import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';

export const dynamic    = 'force-dynamic';
export const maxDuration = 300;

// ─── Config ──────────────────────────────────────────────────────────────────

const OPUS   = 'claude-opus-4-20250514';
const SONNET = 'claude-sonnet-4-20250514';
const HAIKU  = 'claude-haiku-4-5-20251001';
const BATCH  = 5;                // parallel chunk concurrency
const SEQ_CHUNKS = 1;            // translate first N chunks sequentially for memory
const RECHECK_THRESHOLD = 96;   // re-review chunks scoring below this on weighted rubric score
const MAX_REVIEW_ROUNDS = 3;    // max iterative review rounds per chunk (raised from 2 for stubborn chunks)
const API_TIMEOUT_MS    = 120_000; // 120s per Claude call
const MAX_RETRIES       = 2;      // retries for transient errors

// ─── Anthropic API helper (with timeout + retry) ────────────────────────────

function callClaudeOnce(params: {
  model: string; max_tokens: number; system: string;
  messages: Array<{ role: string; content: string }>; apiKey: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: params.model, max_tokens: params.max_tokens,
      system: params.system, messages: params.messages,
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': params.apiKey, 'anthropic-version': '2023-06-01',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          const code = res.statusCode ?? 0;
          reject(Object.assign(new Error(`Anthropic API ${code}: ${raw.slice(0, 300)}`), { statusCode: code }));
          return;
        }
        try {
          const data = JSON.parse(raw) as { content?: Array<{ type: string; text?: string }> };
          const text = data.content?.[0]?.text?.trim();
          if (!text) { reject(new Error('Empty response from Anthropic API')); return; }
          resolve(text);
        } catch { reject(new Error('Parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.setTimeout(API_TIMEOUT_MS, () => { req.destroy(); reject(new Error('Anthropic API timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callClaude(params: {
  model: string; max_tokens: number; system: string;
  messages: Array<{ role: string; content: string }>; apiKey: string;
}): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callClaudeOnce(params);
    } catch (err: unknown) {
      const code = (err as { statusCode?: number }).statusCode ?? 0;
      const isRetryable = code === 429 || code === 500 || code === 529 || (err instanceof Error && err.message === 'Anthropic API timeout');
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

// ─── Parallel batch helper (tolerant of individual failures) ────────────────

async function parallelBatch<T>(
  items: T[], fn: (item: T, index: number) => Promise<void>, batchSize: number,
): Promise<void> {
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const results = await Promise.allSettled(batch.map((item, bi) => fn(item, start + bi)));
    // Re-throw the first failure so the pipeline can handle it
    const firstFailure = results.find(r => r.status === 'rejected');
    if (firstFailure && firstFailure.status === 'rejected') throw firstFailure.reason;
  }
}

// Safe slice that doesn't cut mid-word
function safeSlice(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(' ', max);
  return cut > 0 ? s.slice(0, cut) : s.slice(0, max);
}

// ─── Deterministic Post-Processors ────────────────────────────────────────────

/** Replace forbidden terminology with BAPS-mandated terms */
function enforceTerminology(text: string): string {
  let t = text;
  // Whole-word replacements (case-insensitive)
  t = t.replace(/\btemples\b/gi, (m: string) => m[0] === 'T' ? 'Mandirs' : 'mandirs');
  t = t.replace(/\btemple\b/gi, (m: string) => m[0] === 'T' ? 'Mandir' : 'mandir');
  t = t.replace(/\bpenance\b/gi, 'austerities');
  t = t.replace(/\btorchbearer\b/gi, 'successor');
  t = t.replace(/\baarti\b/gi, 'arti');
  t = t.replace(/\bvicharan\b/gi, 'vichran');
  // Phrase replacements
  t = t.replace(/\bLord Swaminarayan\b/g, 'Bhagwan Swaminarayan');
  t = t.replace(/\bdivine abode\b/gi, 'Akshardham');
  t = t.replace(/\bShrijimaharaj\b/g, 'Shriji Maharaj');
  return t;
}

/** Fix curly quotes, en dashes, and strip forbidden diacritics */
function postProcess(text: string): string {
  let t = text;
  // Straight double quotes → curly (paired)
  let openDouble = true;
  t = t.replace(/"/g, () => { const q = openDouble ? '\u201c' : '\u201d'; openDouble = !openDouble; return q; });
  // Straight single quotes → curly (only when clearly paired, not apostrophes)
  t = t.replace(/'([^']{2,})'/g, '\u2018$1\u2019');
  // Em dashes → spaced en dashes
  t = t.replace(/\u2014/g, ' \u2013 ');
  t = t.replace(/ {2,}\u2013 {2,}/g, ' \u2013 '); // clean double spaces
  // Strip forbidden diacritics (keep only ā)
  const diacriticMap: Record<string, string> = {
    '\u1e41': 'm', '\u1e6d': 't', '\u1e63': 'sh', '\u015b': 'sh', '\u1e47': 'n',
    '\u012b': 'i', '\u016b': 'u', '\u1e5b': 'r', '\u1e45': 'n', '\u1e0d': 'd', '\u0127': 'h', '\u00f1': 'n',
  };
  for (const [from, to] of Object.entries(diacriticMap)) {
    t = t.split(from).join(to);
  }
  return t;
}

// ─── Gold Standard Context ────────────────────────────────────────────────────

const HOUSE_RULES_CONTEXT = `
AKSHARPITH HOUSE-STYLE RULES (NON-NEGOTIABLE):

1. LANGUAGE: British English, Oxford -ize spellings (organize, realize, colour, travelling, programme, fulfil).

2. PUNCTUATION (HIGHEST PRIORITY):
   - Use curly double speech marks \u201c \u201d for ALL quotations, speech, verse transliterations, and book titles. NEVER use straight quotes (' or ").
   - For nested quotes: \u201cSwamishri said, \u2018Prapti is 24 hours.\u2019\u201d
   - Spaced en dash ( \u2013 ) for parenthetical clauses. NEVER em dash.
   - Footnotes end with full stops if complete sentences.
   - EXAMPLES: \u201cCambridge History of Gujarat\u201d NOT 'Cambridge History of Gujarat'. \u201cPreme pragaty\u0101 re suraj\u201d NOT 'Preme pragatya re suraj'.

3. DIACRITICS (HIGHLY RESTRICTED — CRITICAL RULE):
   - The ONLY diacritical mark permitted ANYWHERE is \u0101 (a with macron).
   - \u0101 may ONLY appear when directly quoting poetic/canonical verses (e.g., \u201cPreme pragaty\u0101 re s\u016braj Sahaj\u0101nand\u201d)
   - ABSOLUTELY NEVER use: \u1e41 (ṁ), \u1e6d (ṭ), \u1e63 (ṣ), \u015b (ś), \u1e47 (ṇ), \u012b (ī), \u016b (ū), \u1e5b (ṛ), \u1e45 (ṅ), \u1e0d (ḍ), \u0127 (ḥ), or ANY other diacritical mark.
   - In verse transliteration: use PLAIN Roman letters for ALL consonants and vowels EXCEPT \u0101. Write "sh" not "\u015b", "n" not "\u1e47", "t" not "\u1e6d", "m" not "\u1e41".
   - In prose: prapti, bhakti, anand, murti (absolutely no diacritics).
   - BOUNDARY RULE: If a verse is quoted inline, diacritics (\u0101 only) apply ONLY within the quoted verse. Surrounding prose must be diacritics-free.

4. MANDATORY TERMINOLOGY:
   - mandir (NEVER "temple")
   - Swami / Swamis (NEVER "saint" / "sadhu" when referring to BAPS or genuine ascetics)
   - bawa / bawas (for impostor ascetics, fraudulent religious figures, or pseudo-sadhus described negatively in the source)
   - devotee(s) (not "haribhakta")
   - Akshardham (NEVER "divine abode")
   - Shriji Maharaj (two words \u2014 NEVER "Shrijimaharaj")
   - Bhagwan Swaminarayan (not "Lord Swaminarayan")
   - Mahant Swami Maharaj \u2192 Swamishri (after first reference)
   - Pramukh Swami Maharaj \u2192 Swamishri (after first reference)
   - austerities (not "penance")
   - mukhpath (not "recitation")
   - shastra (not "scripture" in spiritual context)
   - seva (not "service" in spiritual context)
   - satsang (not "fellowship")
   - santmandal (for a collective group of saints)
   - paramhansa, bawa, arti, vichran (BAPS standard spellings)
   - brahmisthiti (not "Brahmic state")
   - successor (not "torchbearer")
   - arti (not "aarti" \u2014 single a)

5. PLACE NAMES (EXACT SPELLINGS):
   Chansad, Bamangam, Dhuliya, Dangara, Bhadrod, Piplana

6. HISTORICAL INTEGRITY:
   - Preserve exact dates in BRITISH format: \u201c3 April 1781\u201d NOT "April 3, 1781".
   - Preserve exact time stamps (e.g. 2.16 a.m.), all numbers.
   - Never approximate unless the source approximates.
   - Historical names: use era-correct names (e.g., \u201cBombay Province\u201d not "Mumbai").
   - Never infer inner thoughts unless the source documents them.

7. TONE: Dignified, measured, reverent, clear, intellectually honest.
   - Never: hype, dramatic exaggeration, "life-changing", "BAPS is proud\u2026"
   - Never: casual register, American marketing tone.
   - Never: "mythology" for Hindu texts (use "scripture" or "sacred history").
   - Never: modern management terms (CEO, strategy, etc.) in historical contexts.

8. TRANSLATION FIDELITY:
   - Preserve meaning, sequence, theology, emotional tone.
   - Do NOT add interpretation not present in source.
   - Do NOT paraphrase or summarise \u2014 translate fully, line by line.
   - Do NOT soften strong expressions.
   - Retain direct quotes in first person; never convert to indirect speech.

9. POETRY & VERSE (CRITICAL):
   - For EVERY verse block: provide Roman transliteration FIRST, then English meaning in parentheses. NEVER provide transliteration without its English meaning. Both are MANDATORY.
   - In transliteration: use ONLY plain Roman letters plus \u0101. Example: "Preme pragaty\u0101 re suraj Sahaj\u0101nand" — NOT "Preme pragaty\u0101 re s\u016braj Sahaj\u0101nand".
   - Wrap verse transliterations in curly double quotes (\u201c \u201d), same as all other quotations.
   - Example format:
     “Preme pragatyā re suraj Sahajānand, adharma andhāru tāliyu...” (“With love manifested the sun Sahajanand, dispelling the darkness of unrighteousness...”)
   - Retain original Gujarati/Sanskrit verse line intact.
   - Italicise transliterated verses.

10. FORMATTING:
    - Preserve all paragraph breaks from source.
    - No headers unless present in source.
    - Italicise book titles.
    - Do not add ellipsis to truncate verse \u2014 reproduce in full.`;

const KEY_GLOSSARY = `
KEY THEOLOGICAL GLOSSARY (use these exact English renderings):
akshar: Imperishable; second-highest of five eternal realities
Akshardham: The highest divine abode of Bhagwan Swaminarayan
akshar-mukta: A jiva that has attained ultimate liberation
antahkaran: Inner faculty (mind, buddhi, chitt, ahamkar collectively)
atma: Soul / individual self
ahamkar: Ego; sense of individual existence
bhakti: Devotion
brahmand: Universe / cosmic realm
brahmarup: Having the nature/qualities of Akshar
chitt: The contemplative faculty of antahkaran
dharma: Righteousness; cosmic/moral order
dhyan: Meditation
ishwar: God in controller role; divine beings governing realms
jiva: Individual soul
katha: Spiritual discourse / scripture reading
kirtan: Devotional hymn / song
maharaj: Revered title for Bhagwan Swaminarayan
mandir: Sanctified abode; place of worship (never "temple")
maya: Cosmic illusion / the root cause of ignorance
moksha: Liberation
murti: Consecrated image of God
nishkam: Devoid of worldly desires
paramhansa: Highest order of ascetic; BAPS renunciant
Parabrahma: Supreme Being; Bhagwan Swaminarayan
Purushottam: Highest of all; Bhagwan Swaminarayan
satsang: Fellowship of truth; BAPS community (never "fellowship")
Swamishri: Revered address for the current/previous spiritual successor
vachanamrut: Recorded divine discourses of Bhagwan Swaminarayan
vichran: Travels/tours of a spiritual leader (BAPS spelling)`;

// BAPS terms the smoother and assembler must never replace
const PROTECTED_TERMS = 'mandir, seva, satsang, arti, vichran, mukhpath, katha, kirtan, dharma, moksha, bhakti, atma, maya, paramhansa, brahmisthiti, santmandal, shastra, Swamishri, Akshardham, vachanamrut';

// ─── Deterministic chunker ─────────────────────────────────────────────────
// Splits at blank-line paragraph boundaries, targeting 300–500 words per chunk.
// If the full text is ≤500 words, returns it as a single chunk.

// Detect if a paragraph is a verse block (transliterated text, poetic structure, or quoted verse)
function isVerseBlock(para: string): boolean {
  const lines = para.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  // Quoted transliterated text (lines starting with quotes containing transliterated words)
  const quotedVerse = lines.some(l => /^[\u201c\u201d"'\u2018\u2019]/.test(l) && /[āīūṛṅñṭḍṇśṣḥ]/.test(l));
  // Poetic structure: multiple short lines of similar length (verse stanzas)
  const avgLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
  const similarLength = lines.length >= 2 && lines.every(l => Math.abs(l.length - avgLen) < avgLen * 0.5);
  // Lines containing diacritical marks typical of transliteration
  const diacriticLines = lines.filter(l => /[āīūṛṅñṭḍṇśṣḥ]/.test(l)).length;
  const mostlyDiacritic = diacriticLines >= lines.length * 0.5;
  return quotedVerse || (similarLength && mostlyDiacritic);
}

function deterministicChunk(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const totalWords = trimmed.split(/\s+/).filter(Boolean).length;
  if (totalWords <= 500) return [trimmed];

  // Try double-newline split first; if any paragraph > 500 words, fall back to single-newline
  let rawParagraphs = trimmed.split(/\n\s*\n/);
  const hasGiantPara = rawParagraphs.some(p => p.trim().split(/\s+/).length > 500);
  if (hasGiantPara) {
    rawParagraphs = trimmed.split(/\n/).filter(l => l.trim());
  }
  const paragraphs = rawParagraphs;

  // Group verse blocks with their preceding paragraph to keep them together
  const groups: string[] = [];
  let pendingVerse: string | null = null;
  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    if (isVerseBlock(p)) {
      // Attach verse to previous group if one exists, otherwise hold it
      if (groups.length > 0) {
        groups[groups.length - 1] += '\n\n' + p;
      } else {
        pendingVerse = pendingVerse ? pendingVerse + '\n\n' + p : p;
      }
    } else {
      if (pendingVerse) {
        groups.push(pendingVerse + '\n\n' + p);
        pendingVerse = null;
      } else {
        groups.push(p);
      }
    }
  }
  if (pendingVerse) groups.push(pendingVerse);

  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const group of groups) {
    const groupWords = group.split(/\s+/).length;

    if (currentWords + groupWords > 500 && currentWords >= 300) {
      chunks.push(current.join('\n\n'));
      current = [group];
      currentWords = groupWords;
    } else {
      current.push(group);
      currentWords += groupWords;
    }
  }

  if (current.length > 0) {
    if (currentWords < 150 && chunks.length > 0) {
      chunks[chunks.length - 1] += '\n\n' + current.join('\n\n');
    } else {
      chunks.push(current.join('\n\n'));
    }
  }

  return chunks.length > 0 ? chunks : [trimmed];
}

// ─── System Prompts ──────────────────────────────────────────────────────────

const TRANSLATOR_SYSTEM = `You are a trustee of tradition (parampara) for Aksharpith, the publishing wing of BAPS Swaminarayan Sanstha. Your priority is FIDELITY OVER FLUENCY. You are a carrier of the original voice \u2014 not a commentator, not an editor.

${HOUSE_RULES_CONTEXT}

${KEY_GLOSSARY}

UNLISTED TERMS: If you encounter a Gujarati term not in the glossary, transliterate it without diacritics and keep it untranslated. Use context to make the meaning clear. Never invent an English gloss.

ALREADY-ENGLISH TEXT: If a passage in the source is already in English, reproduce it exactly.

MINDSET: Every sentence carries devotional, historical, and doctrinal weight. Preserve it completely. Provide ONLY the English translation \u2014 no preamble, no notes, no commentary.`;

const REVIEWER_SYSTEM = `You are a BAPS translation auditor and senior style reviewer for Aksharpith. You are reviewing text produced by ANOTHER translator \u2014 you did NOT write this text. Perform a combined certification and style audit in a single pass.

IMPORTANT: You are an INDEPENDENT auditor. Score objectively against the weighted rubric below. Do not inflate scores. If you produce a revised translation, you are correcting the original translator's work, not your own.

WEIGHTED SCORING RUBRIC (6 categories, 100 points total):

1. FIDELITY (30 pts) \u2014 Nothing added/omitted/paraphrased. Every Gujarati sentence must map to an English sentence. Direct quotes stay first-person. Numbers, dates, names preserved exactly. No commentary. No interpretation.

2. TERMINOLOGY (25 pts) \u2014 Verify mandatory terms:
   mandir (NEVER "temple") | Swami/Swamis (NEVER "saint/saints/sadhu" for BAPS ascetics)
   bawa (for impostor ascetics) | austerities (NEVER "penance")
   Shriji Maharaj (two words \u2014 NEVER "Shrijimaharaj")
   Bhagwan Swaminarayan (NEVER "Lord Swaminarayan")
   Akshardham (NEVER "divine abode") | paramhansa
   devotees (NEVER "haribhaktas") | arti (NEVER "aarti") | vichran (NEVER "vicharan")
   satsang | seva | santmandal | brahmisthiti
   successor (NEVER "torchbearer") | Swamishri (after first reference)

3. VERSE HANDLING (15 pts) \u2014 Roman transliteration FIRST, then English meaning. Full reproduction, no truncation. ONLY the diacritical mark \u0101 is permitted in verse transliteration \u2014 NEVER use \u1e41/\u1e6d/\u1e63/\u015b/\u1e47/\u012b/\u016b/\u1e5b/\u1e45/\u1e0d or any other special character. Write plain Roman: "sh" not "\u015b", "n" not "\u1e47", "t" not "\u1e6d". Consistent verse formatting throughout. Verse lines must use curly quotes (\u201c \u201d).

4. STYLE & REGISTER (15 pts) \u2014 UK English Oxford -ize (organize, realize, colour, travelling, programme, fulfil). Curly quotes \u201c \u201d (NEVER straight). Spaced en dash ( \u2013 ) NEVER em dash. Dignified, reverent, scholarly tone. No "mythology" for sacred texts. No American marketing tone. No modern management terms.

5. HISTORICAL PRECISION (10 pts) \u2014 Era-correct names (e.g. "Bombay Province" not "Mumbai"). Exact dates/timestamps. Exact place spellings: Chhapaiya, Kathiawad, Chansad, Bamangam, Dhuliya, Dangara, Bhadrod. Correct attribution of historical quotes.

6. COMPLETENESS (5 pts) \u2014 All paragraphs translated. No summarisation. No truncation. Every verse reproduced in full.

DEDUCTION RULES (per category):
- Critical violation: \u221260% of that category's weight
- Major violation: \u221240% of that category's weight
- Minor violation: \u221220% of that category's weight
- Each category score cannot go below 0

Total = sum of all 6 category scores (max 100).
Set "certifiable" to true ONLY if total >= 97 AND zero critical violations across all categories.

COMMON PITFALLS (check each):
1. saints\u2192Swamis 2. temple\u2192mandir 3. Lord Swaminarayan\u2192Bhagwan Swaminarayan
4. divine abode\u2192Akshardham 5. Shrijimaharaj\u2192Shriji Maharaj 6. penance\u2192austerities
7. haribhaktas\u2192devotees 8. indirect speech conversion 9. added commentary
10. straight quotes 11. em dash 12. macrons in prose 13. missing transliteration
14. mythology 15. aarti\u2192arti 16. vicharan\u2192vichran 17. torchbearer\u2192successor
18. place name misspellings 19. American spellings 20. satsang\u2192fellowship
21. forbidden diacritics (\u1e41 \u1e6d \u1e63 \u015b \u1e47 \u012b \u016b \u1e5b \u1e0d) in verse\u2192replace with plain Roman + \u0101 only
22. straight quotes on verse lines\u2192curly quotes
23. "sadhu/sadhus" for impostors\u2192"bawa/bawas"

Produce a corrected revised translation fixing ALL issues found.

Return ONLY valid JSON (no fences):
{"categories": [{"id": "FIDELITY", "weight": 30, "score": 28, "deductions": ["Minor: ..."], "pass": true}, {"id": "TERMINOLOGY", "weight": 25, "score": 25, "deductions": [], "pass": true}, {"id": "VERSE_HANDLING", "weight": 15, "score": 15, "deductions": [], "pass": true}, {"id": "STYLE_REGISTER", "weight": 15, "score": 15, "deductions": [], "pass": true}, {"id": "HISTORICAL_PRECISION", "weight": 10, "score": 10, "deductions": [], "pass": true}, {"id": "COMPLETENESS", "weight": 5, "score": 5, "deductions": [], "pass": true}], "totalScore": 98, "certifiable": true, "revised": "..."}`;

const STYLE_REVIEWER_SYSTEM = `You are a senior style and register reviewer for Aksharpith. The text you receive has already passed BAPS certification (terminology, punctuation, diacritics, fidelity). Your job is ONLY to review style, register, and prose quality.

REVIEW CRITERIA:

1. REGISTER: Flag casual, promotional, or American-register phrasing. Ensure British English, Oxford -ize throughout.
2. PROSE QUALITY: Flag awkward calques from Gujarati syntax, overly literal phrasing, or unnatural English.
3. CONSISTENCY: Flag inconsistent term renderings across the passage (same Gujarati word translated differently).
4. FLOW: Flag abrupt jumps, choppy prose, or poor transitions between ideas.
5. SENTENCE STRUCTURE: Flag overly long sentences (>40 words) that could be split for clarity without changing meaning.

NEVER CHANGE:
- Any BAPS terminology or proper nouns
- Direct quotes from any named figure
- Transliterated verses and their translations
- Dates, numbers, time stamps
- Curly quotes, spaced en dashes, and all punctuation formatting
- These terms: ${PROTECTED_TERMS}

SCORING: Start at 100. Deduct per issue:
- Minor (awkward phrasing, repetitive openers): 2-4 pts
- Moderate (register inconsistency, poor flow): 5-8 pts
- Major (American English, casual tone, calque): 8-12 pts

Produce a revised translation fixing ALL style issues while preserving meaning exactly.

Return ONLY valid JSON (no fences):
{"style_issues": ["issue1", ...], "style_score": <0-100>, "revised": "..."}`;

const SMOOTHER_SYSTEM = `You are a senior editorial reader for Aksharpith performing a final readability pass. The text you receive has already been certified by a BAPS auditor \u2014 all terminology, punctuation, and diacritics are correct. Your job is ONLY to improve prose flow.

IMPROVE:
- Smooth awkward phrasing and unnatural flow in narrative prose
- Restructure overly long or heavily nested sentences
- Add natural transitions where the English feels abrupt
- Remove repetitive sentence openings

NEVER CHANGE:
- Direct quotes from any named figure, scholar, or Swami \u2014 WORD FOR WORD
- Transliterated verses and their translations \u2014 reproduce in full
- All proper nouns, Sanskrit/Gujarati terms, place names, personal names
- All dates, numbers, time stamps
- Curly quotes (\u201c \u201d), spaced en dashes ( \u2013 ), and all punctuation formatting
- These BAPS terms (never replace with English equivalents): ${PROTECTED_TERMS}
- Any phrasing that appears deliberately structured for doctrinal precision, even if slightly awkward in English

If the input is entirely verse/poetry with no narrative prose, return it unchanged.

CRITICAL RULE: If in doubt about whether a change preserves meaning, DO NOT make the change. Err on the side of preserving the certified text. Minimal, targeted improvements only.

STYLE: En dash ( \u2013 ) throughout | British English, Oxford -ize | Curly quotes | Reverent tone

Return ONLY the revised text \u2014 no preamble, no notes.`;

const ASSEMBLER_SYSTEM = `You are a senior editor assembling a multi-chunk translation into a single publication-ready document.

STRUCTURAL OPERATIONS ONLY:
- Remove all chunk markers, separators, and numbering
- If two adjacent chunks overlap (repeated sentences at boundaries), deduplicate
- Ensure no orphaned headings or broken paragraphs at join points
- Preserve chapter headings exactly as they appear

DO NOT:
- Rewrite, rephrase, or alter any sentence content
- Add transitional phrases not present in the chunks
- Change terminology, spelling, or punctuation
- Remove or reorder any paragraphs
- Replace these terms: ${PROTECTED_TERMS}

Output ONLY the final document \u2014 no preamble or notes.`;

// ─── Agent functions ────────────────────────────────────────────────────────

function chunkerAgent(_apiKey: string, text: string): Promise<string[]> {
  return Promise.resolve(deterministicChunk(text));
}

async function translatorAgent(
  apiKey: string, chunk: string,
  translationMemory: string, chunkIndex: number, totalChunks: number,
): Promise<string> {
  const memorySection = translationMemory ? `\nTRANSLATION MEMORY (decisions from previous chunks \u2014 maintain consistency):\n${translationMemory}\n\n${'─'.repeat(40)}\n` : '';
  return callClaude({
    model: OPUS, max_tokens: 8192, apiKey,
    system: TRANSLATOR_SYSTEM,
    messages: [{ role: 'user', content: `${memorySection}Chunk ${chunkIndex + 1} of ${totalChunks}. Translate the following Gujarati text to English. Provide ONLY the translation.\n\nGUJARATI:\n${chunk}` }],
  });
}

interface ReviewResult {
  categories: Array<{ id: string; weight: number; score: number; deductions: string[]; pass: boolean }>;
  pitfalls: string[];
  issues: string[];
  score: number;       // mapped from totalScore for downstream compatibility
  revised: string;
  certifiable: boolean;
}

async function reviewerAgent(apiKey: string, original: string, translation: string): Promise<ReviewResult> {
  const fallback: ReviewResult = { categories: [], pitfalls: [], issues: [], score: 50, revised: translation, certifiable: false };
  let raw: string;
  try {
    raw = await callClaude({
      model: OPUS, max_tokens: 16000, apiKey,
      system: REVIEWER_SYSTEM,
      messages: [{ role: 'user', content: `GUJARATI SOURCE:\n${original}\n\nTRANSLATION TO AUDIT:\n${translation}` }],
    });
  } catch (err) {
    console.error('Reviewer API call failed:', err instanceof Error ? err.message : err);
    return fallback;
  }

  // Strip markdown code fences that LLMs often wrap JSON in
  const stripped = raw.replace(/^```(?:json)?\s*/gm, '').replace(/\s*```$/gm, '');

  // Try to extract JSON object from the response
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('Reviewer returned no JSON object. Raw response (first 500 chars):', raw.slice(0, 500));
    return fallback;
  }

  let jsonStr = match[0];

  // Attempt standard parse first
  try {
    const p = JSON.parse(jsonStr);
    // Map totalScore (weighted rubric) to score for downstream compatibility; fall back to legacy p.score
    const rawScore = typeof p.totalScore === 'number' ? p.totalScore : (typeof p.score === 'number' ? p.score : 50);
    // Normalise categories to new weighted format
    const cats: ReviewResult['categories'] = Array.isArray(p.categories)
      ? p.categories.map((c: Record<string, unknown>) => ({
          id:         typeof c.id === 'string' ? c.id : '',
          weight:     typeof c.weight === 'number' ? c.weight : 0,
          score:      typeof c.score === 'number' ? Math.max(0, c.score as number) : 0,
          deductions: Array.isArray(c.deductions) ? (c.deductions as unknown[]).filter((s: unknown) => typeof s === 'string') as string[] : (Array.isArray(c.issues) ? (c.issues as unknown[]).filter((s: unknown) => typeof s === 'string') as string[] : []),
          pass:       typeof c.pass === 'boolean' ? c.pass : true,
        }))
      : [];
    return {
      categories:  cats,
      pitfalls:    Array.isArray(p.pitfalls) ? p.pitfalls.filter((s: unknown) => typeof s === 'string') : [],
      issues:      Array.isArray(p.issues) ? p.issues.filter((s: unknown) => typeof s === 'string') : [],
      score:       Math.max(0, Math.min(100, rawScore)),
      revised:     typeof p.revised === 'string' && p.revised.trim() ? p.revised.trim() : translation,
      certifiable: typeof p.certifiable === 'boolean' ? p.certifiable : false,
    };
  } catch {
    // JSON parse failed — likely truncated response. Try to salvage what we can.
    console.error('Reviewer JSON parse failed (likely truncated). Attempting partial extraction. Raw length:', raw.length, 'First 300 chars:', raw.slice(0, 300));

    // Try to extract totalScore first (weighted rubric), fall back to score
    let score = 50;
    const totalScoreMatch = jsonStr.match(/"totalScore"\s*:\s*(\d+)/);
    if (totalScoreMatch) {
      score = Math.max(0, Math.min(100, parseInt(totalScoreMatch[1], 10)));
    } else {
      const scoreMatch = jsonStr.match(/"score"\s*:\s*(\d+)/);
      if (scoreMatch) {
        score = Math.max(0, Math.min(100, parseInt(scoreMatch[1], 10)));
      }
    }

    // Try to extract revised text (may be truncated)
    let revised = translation; // default: use original translation
    const revisedMatch = jsonStr.match(/"revised"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
    if (revisedMatch && revisedMatch[1].trim().length > 50) {
      // Only use extracted revised if it's substantial enough
      try {
        // Unescape JSON string escapes
        revised = JSON.parse(`"${revisedMatch[1]}"`);
      } catch {
        // If unescape fails, use original translation
        revised = translation;
      }
    }

    // Try to extract certifiable
    let certifiable = false;
    const certMatch = jsonStr.match(/"certifiable"\s*:\s*(true|false)/);
    if (certMatch) {
      certifiable = certMatch[1] === 'true';
    }

    // Try to extract categories
    let categories: ReviewResult['categories'] = [];
    try {
      const catMatch = jsonStr.match(/"categories"\s*:\s*\[[\s\S]*?\]/);
      if (catMatch) {
        categories = JSON.parse(catMatch[0].replace(/^"categories"\s*:\s*/, ''));
      }
    } catch { /* ignore */ }

    // Try to extract pitfalls
    let pitfalls: string[] = [];
    try {
      const pitMatch = jsonStr.match(/"pitfalls"\s*:\s*\[[\s\S]*?\]/);
      if (pitMatch) {
        pitfalls = JSON.parse(pitMatch[0].replace(/^"pitfalls"\s*:\s*/, '')).filter((s: unknown) => typeof s === 'string');
      }
    } catch { /* ignore */ }

    // Try to extract issues
    let issues: string[] = [];
    try {
      const issMatch = jsonStr.match(/"issues"\s*:\s*\[[\s\S]*?\]/);
      if (issMatch) {
        issues = JSON.parse(issMatch[0].replace(/^"issues"\s*:\s*/, '')).filter((s: unknown) => typeof s === 'string');
      }
    } catch { /* ignore */ }

    return { categories, pitfalls, issues, score, revised, certifiable };
  }
}

interface StyleReviewResult {
  style_issues: string[];
  style_score: number;
  revised: string;
}

async function styleReviewerAgent(apiKey: string, text: string): Promise<StyleReviewResult> {
  const fallback: StyleReviewResult = { style_issues: [], style_score: 90, revised: text };
  let raw: string;
  try {
    raw = await callClaude({
      model: SONNET, max_tokens: 16000, apiKey,
      system: STYLE_REVIEWER_SYSTEM,
      messages: [{ role: 'user', content: `Review the style and register of this certified translation. Return ONLY valid JSON.\n\nTRANSLATION:\n${text}` }],
    });
  } catch (err) {
    console.error('Style reviewer API call failed:', err instanceof Error ? err.message : err);
    return fallback;
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('Style reviewer returned no JSON object. Raw (first 500 chars):', raw.slice(0, 500));
    return fallback;
  }

  try {
    const p = JSON.parse(match[0]);
    return {
      style_issues: Array.isArray(p.style_issues) ? p.style_issues.filter((s: unknown) => typeof s === 'string') : [],
      style_score:  typeof p.style_score === 'number' ? Math.max(0, Math.min(100, p.style_score)) : 90,
      revised:      typeof p.revised === 'string' && p.revised.trim() ? p.revised.trim() : text,
    };
  } catch {
    console.error('Style reviewer JSON parse failed. Using fallback.');
    return fallback;
  }
}

// Character-level diff ratio: proportion of characters that differ between two strings
function charDiffRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  let diffs = Math.abs(a.length - b.length);
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) diffs++;
  }
  return diffs / maxLen;
}

async function smootherAgent(apiKey: string, text: string): Promise<{ text: string; flagged: boolean }> {
  const smoothed = await callClaude({
    model: SONNET, max_tokens: 8192, apiKey,
    system: SMOOTHER_SYSTEM,
    messages: [{ role: 'user', content: `Perform the readability pass. Return ONLY the revised text.\n\n${text}` }],
  });
  const diffRatio = charDiffRatio(text, smoothed);
  if (diffRatio > 0.15) {
    console.warn(`Smoother changed ${(diffRatio * 100).toFixed(1)}% of characters (>15% threshold). Flagging for review and using original.`);
    return { text, flagged: true };
  }
  return { text: smoothed, flagged: false };
}

async function assemblerAgent(apiKey: string, smoothedChunks: string[]): Promise<string> {
  const combined = smoothedChunks.join('\n\n');
  if (smoothedChunks.length === 1) return combined;
  return callClaude({
    model: SONNET, max_tokens: 64000, apiKey,
    system: ASSEMBLER_SYSTEM,
    messages: [{ role: 'user', content: `Assemble these chunks into a single document:\n\n${combined}` }],
  });
}

// Cross-chunk consistency checker — ensures same terms rendered identically across all chunks
interface ConsistencyResult {
  inconsistencies: Array<{ term: string; variants: string[]; recommended: string }>;
  corrections: Map<number, string>; // chunk index -> corrected text
}

async function crossChunkConsistencyCheck(apiKey: string, chunks: string[]): Promise<ConsistencyResult> {
  if (chunks.length <= 1) return { inconsistencies: [], corrections: new Map() };

  // Send all chunks to Haiku to detect inconsistencies
  const numberedChunks = chunks.map((c, i) => `--- CHUNK ${i + 1} ---\n${c}`).join('\n\n');
  const raw = await callClaude({
    model: HAIKU, max_tokens: 4096, apiKey,
    system: `You are a consistency checker for translated text. Examine all chunks and identify:
1. Same proper nouns rendered differently across chunks (e.g., "avatari Purush" vs "avataric Purush")
2. Same theological/technical terms translated inconsistently
3. Same Gujarati phrases given different English translations

For each inconsistency, recommend the BEST rendering based on BAPS conventions.

Then produce corrected versions of ONLY the chunks that need changes. Keep corrections minimal — change only the inconsistent terms.

Return ONLY valid JSON (no fences):
{"inconsistencies": [{"term": "original", "variants": ["var1", "var2"], "recommended": "best"}], "corrected_chunks": {"1": "full corrected text of chunk 1", ...}}

If no inconsistencies found, return: {"inconsistencies": [], "corrected_chunks": {}}`,
    messages: [{ role: 'user', content: `Check these ${chunks.length} translated chunks for terminology consistency:\n\n${numberedChunks}` }],
  });

  const fallback: ConsistencyResult = { inconsistencies: [], corrections: new Map() };
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;

  try {
    const p = JSON.parse(match[0]);
    const inconsistencies = Array.isArray(p.inconsistencies) ? p.inconsistencies : [];
    const corrections = new Map<number, string>();
    if (p.corrected_chunks && typeof p.corrected_chunks === 'object') {
      for (const [key, value] of Object.entries(p.corrected_chunks)) {
        const idx = parseInt(key, 10) - 1; // Convert 1-based to 0-based
        if (!isNaN(idx) && typeof value === 'string' && value.trim()) {
          corrections.set(idx, value as string);
        }
      }
    }
    return { inconsistencies, corrections };
  } catch {
    console.error('Consistency check JSON parse failed.');
    return fallback;
  }
}

async function extractTranslationMemory(apiKey: string, gujarati: string, english: string): Promise<string> {
  const raw = await callClaude({
    model: HAIKU, max_tokens: 512, apiKey,
    system: `You extract proper noun translation decisions from Gujarati\u2192English translations. Return a concise bulleted list, e.g. "\u2022 \u0a97\u0aa2\u0aa1\u0abe \u2192 Gadhada". Only include non-obvious decisions (NOT standard BAPS terms like mandir, seva, satsang, arti, vichran). If nothing notable, return empty string. No JSON, no preamble.`,
    messages: [{ role: 'user', content: `Gujarati source:\n${safeSlice(gujarati, 500)}\n\nEnglish translation:\n${safeSlice(english, 500)}\n\nList non-obvious proper noun decisions:` }],
  });
  return raw.trim();
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 });
  }

  const { text, chapterTitle, bookId, chapterIndex, totalChapters, bookTitle } = body as {
    text?: string; chapterTitle?: string;
    bookId?: string; chapterIndex?: number; totalChapters?: number; bookTitle?: string;
  };

  if (!text || !text.trim()) {
    return new Response(JSON.stringify({ error: 'No text provided' }), { status: 400 });
  }

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) {
    return new Response(JSON.stringify({ error: 'No text provided' }), { status: 400 });
  }
  if (wordCount > 50000) {
    return new Response(JSON.stringify({ error: `Section too long (${wordCount.toLocaleString()} words). Maximum is 50,000.` }), { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500 });
  }

  let streamClosed = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        if (streamClosed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { /* stream closed */ }
      };

      const keepaliveInterval = setInterval(() => {
        if (streamClosed) return;
        try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { /* closed */ }
      }, 10000);

      try {
        const context = chapterTitle ? ` \u2014 ${chapterTitle}` : '';

        // ── Stage 1: Chunker (deterministic) ────────────────────────────
        send({ stage: 'chunker', status: 'running' });
        const chunks = await chunkerAgent(apiKey, text);
        if (chunks.length === 0) { send({ error: 'No content to translate' }); return; }
        send({ stage: 'chunker', status: 'done', count: chunks.length, chunks, context });

        // ── Stages 2-4: Pipelined per-chunk processing ──────────────────
        const translations: string[] = new Array(chunks.length).fill('');
        const reviews: ReviewResult[] = new Array(chunks.length);
        const smoothedChunks: string[] = new Array(chunks.length).fill('');
        let translationMemory = '';

        // Stage completion tracking
        let translateDone = 0, reviewDone = 0, smoothDone = 0;
        let translatorStarted = false, reviewerStarted = false, smootherStarted = false;
        let styleReviewerStarted = false, styleReviewerFinished = false;
        let translatorFinished = false, reviewerFinished = false, smootherFinished = false;
        let totalRechecks = 0;
        let smootherFlagged = 0;
        const styleReviews: StyleReviewResult[] = new Array(chunks.length);
        let styleReviewDone = 0;

        async function processChunk(i: number) {
          // ── Translate ──
          if (!translatorStarted) { translatorStarted = true; send({ stage: 'translator', status: 'running' }); }
          translations[i] = enforceTerminology(await translatorAgent(apiKey, chunks[i], translationMemory, i, chunks.length));
          translateDone++;
          send({ stage: 'translator', status: 'progress', current: translateDone, total: chunks.length, index: i, translation: translations[i] });
          if (translateDone === chunks.length && !translatorFinished) {
            translatorFinished = true;
            send({ stage: 'translator', status: 'done', memorySize: translationMemory.length });
          }

          // ── Extract translation memory from EVERY chunk (Change 5) ──
          if (chunks.length > 1) {
            try {
              const mem = await extractTranslationMemory(apiKey, chunks[i], translations[i]);
              if (mem) {
                translationMemory = (translationMemory + '\n' + mem).trim().slice(-2000);
              }
            } catch { /* ignore memory extraction failure */ }
          }

          // ── Certification Review (Pass 1 — Opus) ──
          if (!reviewerStarted) { reviewerStarted = true; send({ stage: 'reviewer', status: 'running' }); }
          reviews[i] = await reviewerAgent(apiKey, chunks[i], translations[i]);
          send({ stage: 'reviewer', status: 'progress', completed: reviewDone + 1, total: chunks.length, index: i, categories: reviews[i].categories, pitfalls: reviews[i].pitfalls, issues: reviews[i].issues, score: reviews[i].score, certifiable: reviews[i].certifiable });

          // ── Re-review loop ──
          for (let round = 1; round <= MAX_REVIEW_ROUNDS && reviews[i].score < RECHECK_THRESHOLD; round++) {
            totalRechecks++;
            send({ stage: 'reviewer', status: 'progress', completed: reviewDone, total: chunks.length, index: i, categories: reviews[i].categories, pitfalls: reviews[i].pitfalls, issues: reviews[i].issues, score: reviews[i].score, certifiable: reviews[i].certifiable, recheck: true, round });
            reviews[i] = await reviewerAgent(apiKey, chunks[i], reviews[i].revised);
            send({ stage: 'reviewer', status: 'progress', completed: reviewDone, total: chunks.length, index: i, categories: reviews[i].categories, pitfalls: reviews[i].pitfalls, issues: reviews[i].issues, score: reviews[i].score, certifiable: reviews[i].certifiable, recheck: true, round });
          }

          reviewDone++;
          if (reviewDone === chunks.length && !reviewerFinished) {
            reviewerFinished = true;
            const certCount = reviews.filter(r => r.certifiable).length;
            const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;
            send({ stage: 'reviewer', status: 'done', certCount, total: chunks.length, avgScore, rechecked: totalRechecks });
          }

          // ── Style Review (Pass 2 — Sonnet) ──
          if (!styleReviewerStarted) { styleReviewerStarted = true; send({ stage: 'style-reviewer', status: 'running' }); }
          styleReviews[i] = await styleReviewerAgent(apiKey, reviews[i].revised);
          styleReviewDone++;
          send({ stage: 'style-reviewer', status: 'progress', completed: styleReviewDone, total: chunks.length, index: i, style_score: styleReviews[i].style_score, style_issues: styleReviews[i].style_issues });
          if (styleReviewDone === chunks.length && !styleReviewerFinished) {
            styleReviewerFinished = true;
            const avgStyleScore = chunks.length > 0 ? styleReviews.reduce((s, r) => s + r.style_score, 0) / chunks.length : 0;
            send({ stage: 'style-reviewer', status: 'done', avgStyleScore: Math.round(avgStyleScore) });
          }

          // ── Smooth (always run on every chunk, with diff-check) ──
          if (!smootherStarted) { smootherStarted = true; send({ stage: 'smoother', status: 'running' }); }
          const smoothResult = await smootherAgent(apiKey, styleReviews[i].revised);
          smoothedChunks[i] = postProcess(enforceTerminology(smoothResult.text));
          if (smoothResult.flagged) smootherFlagged++;
          smoothDone++;
          send({ stage: 'smoother', status: 'progress', completed: smoothDone, total: chunks.length, index: i, flagged: smoothResult.flagged });
          if (smoothDone === chunks.length && !smootherFinished) {
            smootherFinished = true;
            send({ stage: 'smoother', status: 'done', flaggedChunks: smootherFlagged });
          }
        }

        // Process chunk 0 sequentially for translation memory seeding
        await processChunk(0);

        // Process remaining chunks in parallel through the full pipeline
        if (chunks.length > 1) {
          const remaining = Array.from({ length: chunks.length - 1 }, (_, i) => i + 1);
          await parallelBatch(remaining, async (i) => processChunk(i), BATCH);
        }

        // Ensure all stage-done events fire even for single-chunk case
        if (!translatorFinished) { translatorFinished = true; send({ stage: 'translator', status: 'done', memorySize: translationMemory.length }); }
        if (!reviewerFinished) {
          reviewerFinished = true;
          const certCount = reviews.filter(r => r.certifiable).length;
          const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;
          send({ stage: 'reviewer', status: 'done', certCount, total: chunks.length, avgScore, rechecked: totalRechecks });
        }
        if (!styleReviewerFinished) {
          styleReviewerFinished = true;
          const avgStyleScore = chunks.length > 0 ? styleReviews.reduce((s, r) => s + r.style_score, 0) / chunks.length : 0;
          send({ stage: 'style-reviewer', status: 'done', avgStyleScore: Math.round(avgStyleScore) });
        }
        if (!smootherFinished) {
          smootherFinished = true;
          send({ stage: 'smoother', status: 'done', flaggedChunks: smootherFlagged });
        }

        // ── Cross-chunk consistency check (Change 4) ──────────────────────
        if (chunks.length > 1) {
          send({ stage: 'consistency', status: 'running' });
          try {
            const consistency = await crossChunkConsistencyCheck(apiKey, smoothedChunks);
            if (consistency.inconsistencies.length > 0) {
              send({ stage: 'consistency', status: 'progress', inconsistencies: consistency.inconsistencies });
              // Apply corrections to affected chunks
              consistency.corrections.forEach((corrected, idx) => {
                smoothedChunks[idx] = corrected;
              });
            }
            send({ stage: 'consistency', status: 'done', issuesFound: consistency.inconsistencies.length, chunksFixed: consistency.corrections.size });
          } catch (err) {
            console.error('Consistency check failed:', err instanceof Error ? err.message : err);
            send({ stage: 'consistency', status: 'done', issuesFound: 0, chunksFixed: 0, warning: 'Consistency check failed, proceeding without it' });
          }
        }

        // ── Stage 5: Assembler (Sonnet) ─────────────────────────────────
        const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;
        send({ stage: 'assembler', status: 'running' });
        const assembled = postProcess(await assemblerAgent(apiKey, smoothedChunks));
        const finalWords = assembled.trim().split(/\s+/).filter(Boolean).length;
        send({ stage: 'assembler', status: 'done', output: assembled, wordCount: finalWords, avgScore: Math.round(avgScore) });

        // Save to Firestore (with error notification)
        try {
          await adminDb.collection('translations').add({
            uid: authUser.uid,
            email: authUser.email,
            chapterTitle: chapterTitle || null,
            bookId: bookId || null,
            bookTitle: bookTitle || null,
            chapterIndex: chapterIndex ?? null,
            totalChapters: totalChapters ?? null,
            inputWordCount: wordCount,
            outputWordCount: finalWords,
            avgScore: Math.round(avgScore),
            output: assembled,
            inputPreview: text.slice(0, 300),
            createdAt: new Date().toISOString(),
          });
        } catch (err: unknown) {
          console.error('Firestore save error:', err);
          send({ warning: 'Translation complete but could not save to history. Copy your output now.' });
        }

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        console.error('Pipeline error:', msg);
        send({ error: msg });
      } finally {
        clearInterval(keepaliveInterval);
        streamClosed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
