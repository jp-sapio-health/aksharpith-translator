import https from 'node:https';
import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';

export const dynamic    = 'force-dynamic';
export const maxDuration = 300;

// ─── Config ──────────────────────────────────────────────────────────────────

const SONNET = 'claude-sonnet-4-20250514';
const HAIKU  = 'claude-haiku-4-5-20251001';
const BATCH  = 3;                // parallel chunk concurrency
const RECHECK_THRESHOLD = 80;   // re-review chunks scoring below this

// ─── Anthropic API helper ──────────────────────────────────────────────────────

function callClaude(params: {
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
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Anthropic API ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          const data = JSON.parse(raw) as { content: Array<{ type: string; text: string }> };
          resolve(data.content?.[0]?.text?.trim() ?? '');
        } catch { reject(new Error('Parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Parallel batch helper ──────────────────────────────────────────────────

async function parallelBatch<T>(
  items: T[], fn: (item: T, index: number) => Promise<void>, batchSize: number,
): Promise<void> {
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    await Promise.all(batch.map((item, bi) => fn(item, start + bi)));
  }
}

// Safe slice that doesn't cut mid-word
function safeSlice(s: string, max: number): string {
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

// ─── System Prompts (Bond-audited) ──────────────────────────────────────────

// ─── Deterministic chunker ─────────────────────────────────────────────────
// Splits at blank-line paragraph boundaries, targeting 300–500 words per chunk.
// If the full text is ≤500 words, returns it as a single chunk.

function deterministicChunk(text: string): string[] {
  const totalWords = text.trim().split(/\s+/).length;
  if (totalWords <= 500) return [text.trim()];

  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const paraWords = trimmed.split(/\s+/).length;

    // If adding this paragraph would exceed 500 words and we already have ≥300
    if (currentWords + paraWords > 500 && currentWords >= 300) {
      chunks.push(current.join('\n\n'));
      current = [trimmed];
      currentWords = paraWords;
    } else {
      current.push(trimmed);
      currentWords += paraWords;
    }
  }

  // Flush remaining
  if (current.length > 0) {
    // If the last chunk is too small (<150 words) and there's a previous chunk, merge it
    if (currentWords < 150 && chunks.length > 0) {
      chunks[chunks.length - 1] += '\n\n' + current.join('\n\n');
    } else {
      chunks.push(current.join('\n\n'));
    }
  }

  return chunks.length > 0 ? chunks : [text.trim()];
}

const TRANSLATOR_SYSTEM = `You are a trustee of tradition (parampara) for Aksharpith, the publishing wing of BAPS Swaminarayan Sanstha. Your priority is FIDELITY OVER FLUENCY. You are a carrier of the original voice \u2014 not a commentator, not an editor.

${HOUSE_RULES_CONTEXT}

${KEY_GLOSSARY}

UNLISTED TERMS: If you encounter a Gujarati term not in the glossary, transliterate it without diacritics and keep it untranslated. Use context to make the meaning clear. Never invent an English gloss.

ALREADY-ENGLISH TEXT: If a passage in the source is already in English, reproduce it exactly.

MINDSET: Every sentence carries devotional, historical, and doctrinal weight. Preserve it completely. Provide ONLY the English translation \u2014 no preamble, no notes, no commentary.`;

const REVIEWER1_SYSTEM = `You are a BAPS translation certification auditor. Perform a structured pre-publication certification audit.

BAPS TRANSLATION CERTIFICATION CHECKLIST:

A. TERMINOLOGY \u2014 Verify mandatory terms:
   mandir (NEVER "temple") | Swami/Swamis (NEVER "saint/saints/sadhu")
   Akshardham (NEVER "divine abode") | Shriji Maharaj (two words \u2014 NEVER "Shrijimaharaj")
   Bhagwan Swaminarayan (NEVER "Lord Swaminarayan") | Swamishri (after first reference)
   austerities (NEVER "penance") | devotees (NEVER "haribhaktas")
   seva/satsang/arti/vichran/mukhpath (exact spellings) | successor (NEVER "torchbearer")

B. PUNCTUATION \u2014 Curly quotes \u201c \u201d (NEVER straight) | Spaced en dash ( \u2013 ) NEVER em dash

C. DIACRITICS \u2014 NO macrons in prose. Only inside quoted verse.

D. TONE \u2014 British English, Oxford -ize (organize, realize, colour, travelling, programme, fulfil). No American marketing. No "mythology" for sacred texts.

E. FIDELITY \u2014 Nothing added/omitted. Direct speech stays first-person. No commentary.

F. VERSE \u2014 Transliteration FIRST, then English meaning. Full reproduction, no truncation.

G. HISTORICAL \u2014 Exact dates/times. Place names: Chansad, Bamangam, Dhuliya, Dangara. Era-correct names.

H. COMPLETENESS \u2014 All paragraphs translated, no truncation.

COMMON PITFALLS (check each):
1. saints\u2192Swamis 2. temple\u2192mandir 3. Lord Swaminarayan\u2192Bhagwan Swaminarayan
4. divine abode\u2192Akshardham 5. Shrijimaharaj\u2192Shriji Maharaj 6. penance\u2192austerities
7. haribhaktas\u2192devotees 8. indirect speech conversion 9. added commentary
10. straight quotes 11. em dash 12. macrons in prose 13. missing transliteration
14. mythology 15. aarti\u2192arti 16. vicharan\u2192vichran 17. torchbearer\u2192successor
18. place name misspellings 19. American spellings 20. satsang\u2192fellowship

SCORING: Start at 100. Deduct per issue (minor: 3\u20135pts, major: 8\u201312pts, critical: 15\u201320pts).
Set "certifiable" to true only if ALL 8 categories pass AND zero pitfalls found.
Produce a corrected revised translation fixing ALL issues.

Return ONLY valid JSON (no fences):
{"categories": [{"id": "...", "name": "...", "pass": true, "issues": []}], "pitfalls": [], "score": <0-100>, "revised": "...", "certifiable": false}`;

const REVIEWER2_SYSTEM = `You are a senior style reviewer for Aksharpith. The translation has already passed a BAPS certification audit for terminology, diacritics, and punctuation. Your role is STYLE AND REGISTER only.

CHECK THESE DIMENSIONS:
1. REGISTER: Is the tone consistently dignified, measured, and reverent? Flag casual, promotional, or American-register phrasing.
2. PROSE QUALITY: Are sentences well-constructed? Flag awkward calques from Gujarati syntax, overly literal phrasing, or unnatural English.
3. CONSISTENCY: Are the same terms rendered the same way throughout? Flag inconsistent renderings.
4. BRITISH ENGLISH: Verify Oxford -ize spellings (organize, realize) and British forms (colour, travelling, programme).
5. FLOW: Do paragraphs transition naturally? Flag abrupt jumps or choppy prose.

SCORING: Start at 100. Deduct 3pts per minor style issue, 8pts per register violation, 12pts per consistency error.

Return ONLY valid JSON (no fences):
{"score": <0-100>, "issues": ["issue 1", ...], "revised": "<improved translation>"}`;

const SMOOTHER_SYSTEM = `You are a senior editorial reader for Aksharpith performing a final readability pass.

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
- These BAPS terms (never replace with English equivalents): ${PROTECTED_TERMS}

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
    model: SONNET, max_tokens: 4096, apiKey,
    system: TRANSLATOR_SYSTEM,
    messages: [{ role: 'user', content: `${memorySection}Chunk ${chunkIndex + 1} of ${totalChunks}. Translate the following Gujarati text to English. Provide ONLY the translation.\n\nGUJARATI:\n${chunk}` }],
  });
}

interface ReviewResult { score: number; issues: string[]; revised: string; }

interface Reviewer1Result {
  categories: Array<{ id: string; name: string; pass: boolean; issues: string[] }>;
  pitfalls: string[];
  score: number;
  revised: string;
  certifiable: boolean;
}

async function reviewer1Agent(apiKey: string, original: string, translation: string): Promise<Reviewer1Result> {
  const fallback: Reviewer1Result = { categories: [], pitfalls: [], score: 75, revised: translation, certifiable: false };
  const raw = await callClaude({
    model: SONNET, max_tokens: 8192, apiKey,
    system: REVIEWER1_SYSTEM,
    messages: [{ role: 'user', content: `GUJARATI SOURCE:\n${original}\n\nTRANSLATION TO AUDIT:\n${translation}` }],
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const p = JSON.parse(match[0]);
    return {
      categories:  Array.isArray(p.categories) ? p.categories : [],
      pitfalls:    Array.isArray(p.pitfalls) ? p.pitfalls.filter((s: unknown) => typeof s === 'string') : [],
      score:       typeof p.score === 'number' ? Math.max(0, Math.min(100, p.score)) : 75,
      revised:     typeof p.revised === 'string' && p.revised.trim() ? p.revised.trim() : translation,
      certifiable: typeof p.certifiable === 'boolean' ? p.certifiable : false,
    };
  } catch { return fallback; }
}

async function reviewer2Agent(apiKey: string, original: string, translation: string): Promise<ReviewResult> {
  const raw = await callClaude({
    model: SONNET, max_tokens: 8192, apiKey,
    system: REVIEWER2_SYSTEM,
    messages: [{ role: 'user', content: `ORIGINAL (Gujarati):\n${original}\n\nTRANSLATION TO REVIEW:\n${translation}` }],
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { score: 70, issues: [], revised: translation };
  try {
    const p = JSON.parse(match[0]);
    return {
      score:   typeof p.score === 'number' ? Math.max(0, Math.min(100, p.score)) : 70,
      issues:  Array.isArray(p.issues) ? p.issues.filter((s: unknown) => typeof s === 'string') : [],
      revised: typeof p.revised === 'string' && p.revised.trim() ? p.revised.trim() : translation,
    };
  } catch { return { score: 70, issues: [], revised: translation }; }
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
    model: SONNET, max_tokens: 16000, apiKey,
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

  const body = await req.json().catch(() => ({}));
  const { text, chapterTitle, bookId, chapterIndex, totalChapters, bookTitle } = body as {
    text?: string; chapterTitle?: string;
    bookId?: string; chapterIndex?: number; totalChapters?: number; bookTitle?: string;
  };

  if (!text?.trim()) {
    return new Response(JSON.stringify({ error: 'No text provided' }), { status: 400 });
  }

  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount > 50000) {
    return new Response(JSON.stringify({ error: `Section too long (${wordCount.toLocaleString()} words). Maximum is 50,000.` }), { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      // Global keepalive — single interval for the entire stream
      const keepaliveInterval = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { /* closed */ }
      }, 10000);

      try {
        const context = chapterTitle ? ` — ${chapterTitle}` : '';

        // ── Stage 1: Chunker (Haiku — fast) ────────────────────────────
        send({ stage: 'chunker', status: 'running' });
        const chunks = await chunkerAgent(apiKey, text);
        send({ stage: 'chunker', status: 'done', count: chunks.length, chunks, context });

        // ── Stage 2: Translator (sequential — needs cross-chunk memory) ─
        send({ stage: 'translator', status: 'running' });
        const translations: string[] = new Array(chunks.length).fill('');
        let translationMemory = '';

        for (let i = 0; i < chunks.length; i++) {
          translations[i] = await translatorAgent(apiKey, chunks[i], translationMemory, i, chunks.length);
          send({ stage: 'translator', status: 'progress', current: i + 1, total: chunks.length, index: i, translation: translations[i] });
          if (i < chunks.length - 1) {
            extractTranslationMemory(apiKey, chunks[i], translations[i])
              .then(mem => { if (mem) translationMemory = (translationMemory + '\n' + mem).trim().slice(-2000); })
              .catch(() => {});
          }
        }
        send({ stage: 'translator', status: 'done', memorySize: translationMemory.length });

        // ── Stage 3: Reviewer 1 — PARALLEL ─────────────────────────────
        send({ stage: 'reviewer1', status: 'running' });
        const reviewer1Results: Reviewer1Result[] = new Array(chunks.length);
        let r1Done = 0;

        await parallelBatch(chunks, async (_, i) => {
          reviewer1Results[i] = await reviewer1Agent(apiKey, chunks[i], translations[i]);
          r1Done++;
          send({ stage: 'reviewer1', status: 'progress', completed: r1Done, total: chunks.length, index: i, categories: reviewer1Results[i].categories, pitfalls: reviewer1Results[i].pitfalls, score: reviewer1Results[i].score, certifiable: reviewer1Results[i].certifiable });
        }, BATCH);

        const certCount = reviewer1Results.filter(r => r.certifiable).length;
        send({ stage: 'reviewer1', status: 'done', certCount, total: chunks.length });

        // ── Stage 4: Reviewer 2 — PARALLEL ─────────────────────────────
        send({ stage: 'reviewer2', status: 'running' });
        const reviews: ReviewResult[] = new Array(chunks.length);
        let r2Done = 0;

        await parallelBatch(chunks, async (_, i) => {
          reviews[i] = await reviewer2Agent(apiKey, chunks[i], reviewer1Results[i].revised);
          r2Done++;
          send({ stage: 'reviewer2', status: 'progress', completed: r2Done, total: chunks.length, index: i, score: reviews[i].score, issues: reviews[i].issues, revised: reviews[i].revised });
        }, BATCH);

        // ── Double-loop: re-review low-scoring chunks ──────────────────
        const lowChunks = reviews.map((_, i) => i).filter(i => reviews[i].score < RECHECK_THRESHOLD);
        if (lowChunks.length > 0) {
          send({ stage: 'reviewer2', status: 'rechecking', count: lowChunks.length });

          await parallelBatch(lowChunks, async (i) => {
            // Re-run R1 on the R2-revised text
            reviewer1Results[i] = await reviewer1Agent(apiKey, chunks[i], reviews[i].revised);
            send({ stage: 'reviewer1', status: 'progress', completed: r1Done, total: chunks.length, index: i, categories: reviewer1Results[i].categories, pitfalls: reviewer1Results[i].pitfalls, score: reviewer1Results[i].score, certifiable: reviewer1Results[i].certifiable });
            // Re-run R2 on the new R1-revised text
            reviews[i] = await reviewer2Agent(apiKey, chunks[i], reviewer1Results[i].revised);
            send({ stage: 'reviewer2', status: 'progress', completed: r2Done, total: chunks.length, index: i, score: reviews[i].score, issues: reviews[i].issues, revised: reviews[i].revised, recheck: true });
          }, BATCH);
        }

        const avgScore = reviews.reduce((s, r) => s + r.score, 0) / reviews.length;
        send({ stage: 'reviewer2', status: 'done', avgScore, rechecked: lowChunks.length });

        // ── Stage 5: Smoother — PARALLEL ───────────────────────────────
        send({ stage: 'smoother', status: 'running' });
        const smoothedChunks: string[] = new Array(chunks.length);
        let smDone = 0;

        await parallelBatch(reviews, async (_, i) => {
          smoothedChunks[i] = await smootherAgent(apiKey, reviews[i].revised);
          smDone++;
          send({ stage: 'smoother', status: 'progress', completed: smDone, total: reviews.length, index: i });
        }, BATCH);
        send({ stage: 'smoother', status: 'done' });

        // ── Stage 6: Assembler ─────────────────────────────────────────
        send({ stage: 'assembler', status: 'running' });
        const assembled = await assemblerAgent(apiKey, smoothedChunks);
        const finalWords = assembled.trim().split(/\s+/).length;
        send({ stage: 'assembler', status: 'done', output: assembled, wordCount: finalWords, avgScore: Math.round(avgScore) });

        // Save to Firestore (fire-and-forget)
        adminDb.collection('translations').add({
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
        }).catch((err: unknown) => console.error('Firestore save error:', err));

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        console.error('Pipeline error:', msg);
        send({ error: msg });
      } finally {
        clearInterval(keepaliveInterval);
        controller.close();
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
