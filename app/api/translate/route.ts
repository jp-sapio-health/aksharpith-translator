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
const RECHECK_THRESHOLD = 93;   // re-review chunks scoring below this
const MAX_REVIEW_ROUNDS = 2;    // max iterative review rounds per chunk
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

// ─── Gold Standard Context ────────────────────────────────────────────────────

const HOUSE_RULES_CONTEXT = `
AKSHARPITH HOUSE-STYLE RULES (NON-NEGOTIABLE):

1. LANGUAGE: British English, Oxford -ize spellings (organize, realize, colour, travelling, programme, fulfil).

2. PUNCTUATION (HIGHEST PRIORITY):
   - Curly double speech marks (\u201c \u201d) for ALL direct quotations and speech. NEVER straight quotes.
   - Nested: \u201cSwamishri said, \u2018Prapti is 24 hours.\u2019\u201d
   - Spaced en dash ( \u2013 ) for parenthetical clauses. NEVER em dash.
   - Footnotes end with full stops if complete sentences.

3. DIACRITICS (HIGHLY RESTRICTED):
   - Use \u0101 ONLY when directly quoting poetic/canonical verses (e.g., \u201c\u0100tm\u0101 j\u0101go re\u2026\u201d)
   - NEVER use macrons (\u012b, \u016b, \u1e5b, \u1e45, etc.) in prose.
   - In prose: prapti, bhakti, anand, murti (no diacritics).
   - BOUNDARY RULE: If a verse is quoted inline within a prose paragraph, diacritics apply ONLY within the quoted verse portion. The surrounding prose must remain diacritics-free.

4. MANDATORY TERMINOLOGY:
   - mandir (NEVER "temple")
   - Swami / Swamis (NEVER "saint" / "sadhu")
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
   - Preserve exact dates, exact time stamps (e.g. 2.16 a.m.), all numbers.
   - Never approximate unless the source approximates.
   - Historical names: use era-correct names (e.g., "Bombay Province" not "Mumbai").
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

9. POETRY & VERSE:
   - Include Roman transliteration FIRST, then English meaning.
   - Retain original Gujarati/Sanskrit verse line intact.
   - Use diacritics only within quoted verse.
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

function deterministicChunk(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const totalWords = trimmed.split(/\s+/).filter(Boolean).length;
  if (totalWords <= 500) return [trimmed];

  const paragraphs = trimmed.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    const paraWords = p.split(/\s+/).length;

    if (currentWords + paraWords > 500 && currentWords >= 300) {
      chunks.push(current.join('\n\n'));
      current = [p];
      currentWords = paraWords;
    } else {
      current.push(p);
      currentWords += paraWords;
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

IMPORTANT: You are an INDEPENDENT auditor. Score objectively against the checklist. Do not inflate scores. If you produce a revised translation, you are correcting the original translator's work, not your own.

PART 1 \u2014 BAPS CERTIFICATION CHECKLIST (8 categories):

A. TERMINOLOGY \u2014 Verify mandatory terms:
   mandir (NEVER "temple") | Swami/Swamis (NEVER "saint/saints/sadhu")
   Akshardham (NEVER "divine abode") | Shriji Maharaj (two words \u2014 NEVER "Shrijimaharaj")
   Bhagwan Swaminarayan (NEVER "Lord Swaminarayan") | Swamishri (after first reference)
   austerities (NEVER "penance") | devotees (NEVER "haribhaktas")
   seva/satsang/arti/vichran/mukhpath (exact spellings) | successor (NEVER "torchbearer")

B. PUNCTUATION \u2014 Curly quotes \u201c \u201d (NEVER straight) | Spaced en dash ( \u2013 ) NEVER em dash

C. DIACRITICS \u2014 NO macrons in prose. Only inside quoted verse. If a verse is quoted inline within prose, diacritics apply ONLY within the quoted verse portion.

D. TONE \u2014 British English, Oxford -ize (organize, realize, colour, travelling, programme, fulfil). No American marketing. No "mythology" for sacred texts. Dignified, measured, reverent register.

E. FIDELITY \u2014 Nothing added/omitted. Direct speech stays first-person. No commentary. No paraphrasing.

F. VERSE \u2014 Transliteration FIRST, then English meaning. Full reproduction, no truncation.

G. HISTORICAL \u2014 Exact dates/times. Place names: Chansad, Bamangam, Dhuliya, Dangara, Bhadrod. Era-correct names (e.g. "Bombay Province" not "Mumbai").

H. COMPLETENESS \u2014 All paragraphs translated, no truncation.

COMMON PITFALLS (check each):
1. saints\u2192Swamis 2. temple\u2192mandir 3. Lord Swaminarayan\u2192Bhagwan Swaminarayan
4. divine abode\u2192Akshardham 5. Shrijimaharaj\u2192Shriji Maharaj 6. penance\u2192austerities
7. haribhaktas\u2192devotees 8. indirect speech conversion 9. added commentary
10. straight quotes 11. em dash 12. macrons in prose 13. missing transliteration
14. mythology 15. aarti\u2192arti 16. vicharan\u2192vichran 17. torchbearer\u2192successor
18. place name misspellings 19. American spellings 20. satsang\u2192fellowship

PART 2 \u2014 STYLE AND REGISTER:

1. REGISTER: Flag casual, promotional, or American-register phrasing.
2. PROSE QUALITY: Flag awkward calques from Gujarati syntax, overly literal phrasing, or unnatural English.
3. CONSISTENCY: Flag inconsistent term renderings across the passage.
4. FLOW: Flag abrupt jumps or choppy prose.

SCORING: Start at 100. Deduct per issue:
- Minor (spelling, punctuation): 3\u20135 pts
- Major (wrong term, register violation, consistency): 8\u201312 pts
- Critical (fidelity error, omission, added commentary): 15\u201320 pts
Set "certifiable" to true only if ALL 8 categories pass AND zero pitfalls found.

Produce a corrected revised translation fixing ALL certification and style issues.

Return ONLY valid JSON (no fences):
{"categories": [{"id": "A", "name": "Terminology", "pass": true, "issues": []}, ...], "pitfalls": [], "issues": [], "score": <0-100>, "revised": "...", "certifiable": false}`;

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
  categories: Array<{ id: string; name: string; pass: boolean; issues: string[] }>;
  pitfalls: string[];
  issues: string[];
  score: number;
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

  // Try to extract JSON object from the response
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('Reviewer returned no JSON object. Raw response (first 500 chars):', raw.slice(0, 500));
    return fallback;
  }

  let jsonStr = match[0];

  // Attempt standard parse first
  try {
    const p = JSON.parse(jsonStr);
    return {
      categories:  Array.isArray(p.categories) ? p.categories : [],
      pitfalls:    Array.isArray(p.pitfalls) ? p.pitfalls.filter((s: unknown) => typeof s === 'string') : [],
      issues:      Array.isArray(p.issues) ? p.issues.filter((s: unknown) => typeof s === 'string') : [],
      score:       typeof p.score === 'number' ? Math.max(0, Math.min(100, p.score)) : 50,
      revised:     typeof p.revised === 'string' && p.revised.trim() ? p.revised.trim() : translation,
      certifiable: typeof p.certifiable === 'boolean' ? p.certifiable : false,
    };
  } catch {
    // JSON parse failed — likely truncated response. Try to salvage what we can.
    console.error('Reviewer JSON parse failed (likely truncated). Attempting partial extraction. Raw length:', raw.length, 'First 300 chars:', raw.slice(0, 300));

    // Try to extract score
    let score = 50;
    const scoreMatch = jsonStr.match(/"score"\s*:\s*(\d+)/);
    if (scoreMatch) {
      score = Math.max(0, Math.min(100, parseInt(scoreMatch[1], 10)));
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

async function smootherAgent(apiKey: string, text: string): Promise<string> {
  return callClaude({
    model: SONNET, max_tokens: 8192, apiKey,
    system: SMOOTHER_SYSTEM,
    messages: [{ role: 'user', content: `Perform the readability pass. Return ONLY the revised text.\n\n${text}` }],
  });
}

async function assemblerAgent(apiKey: string, smoothedChunks: string[]): Promise<string> {
  const combined = smoothedChunks.join('\n\n');
  if (smoothedChunks.length === 1) return combined;
  return callClaude({
    model: SONNET, max_tokens: 32000, apiKey,
    system: ASSEMBLER_SYSTEM,
    messages: [{ role: 'user', content: `Assemble these chunks into a single document:\n\n${combined}` }],
  });
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
        let translatorFinished = false, reviewerFinished = false, smootherFinished = false;
        let totalRechecks = 0;

        async function processChunk(i: number) {
          // ── Translate ──
          if (!translatorStarted) { translatorStarted = true; send({ stage: 'translator', status: 'running' }); }
          translations[i] = await translatorAgent(apiKey, chunks[i], translationMemory, i, chunks.length);
          translateDone++;
          send({ stage: 'translator', status: 'progress', current: translateDone, total: chunks.length, index: i, translation: translations[i] });
          if (translateDone === chunks.length && !translatorFinished) {
            translatorFinished = true;
            send({ stage: 'translator', status: 'done', memorySize: translationMemory.length });
          }

          // ── Review ──
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

          // ── Smooth (always run on every chunk) ──
          if (!smootherStarted) { smootherStarted = true; send({ stage: 'smoother', status: 'running' }); }
          smoothedChunks[i] = await smootherAgent(apiKey, reviews[i].revised);
          smoothDone++;
          send({ stage: 'smoother', status: 'progress', completed: smoothDone, total: chunks.length, index: i });
          if (smoothDone === chunks.length && !smootherFinished) {
            smootherFinished = true;
            send({ stage: 'smoother', status: 'done' });
          }
        }

        // Process chunk 0 sequentially for translation memory
        await processChunk(0);

        // Extract translation memory from first chunk
        if (chunks.length > 1) {
          try {
            const mem = await extractTranslationMemory(apiKey, chunks[0], translations[0]);
            if (mem) translationMemory = mem.slice(-2000);
          } catch { /* ignore memory extraction failure */ }
        }

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
        if (!smootherFinished) {
          smootherFinished = true;
          send({ stage: 'smoother', status: 'done' });
        }

        // ── Stage 5: Assembler (Sonnet) ─────────────────────────────────
        const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;
        send({ stage: 'assembler', status: 'running' });
        const assembled = await assemblerAgent(apiKey, smoothedChunks);
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
