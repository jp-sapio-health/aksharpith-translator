import https from 'node:https';
import { NextRequest } from 'next/server';

export const dynamic    = 'force-dynamic';
export const maxDuration = 300;

// ─── Anthropic API helper ──────────────────────────────────────────────────────

function callClaude(params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
  apiKey: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      params.model,
      max_tokens: params.max_tokens,
      system:     params.system,
      messages:   params.messages,
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':          params.apiKey,
        'anthropic-version':  '2023-06-01',
        'content-type':       'application/json',
        'content-length':     Buffer.byteLength(body),
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
        } catch {
          reject(new Error('Parse error: ' + raw.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Gold Standard Context ────────────────────────────────────────────────────
// Source: Aksharpith House Rules, Master Glossary, Examples & Lessons from BAPS Translations

const HOUSE_RULES_CONTEXT = `
AKSHARPITH HOUSE-STYLE RULES (NON-NEGOTIABLE):

1. LANGUAGE: British English, Oxford -ize spellings (organize, realize, colour, travelling, programme, fulfil).

2. PUNCTUATION (HIGHEST PRIORITY):
   - Curly double speech marks (" ") for ALL direct quotations and speech. NEVER straight quotes.
   - Nested: "Swamishri said, 'Prapti is 24 hours.'"
   - Spaced en dash ( – ) for parenthetical clauses. NEVER em dash.
   - Footnotes end with full stops if complete sentences.

3. DIACRITICS (HIGHLY RESTRICTED):
   - Use ā ONLY when directly quoting poetic/canonical verses (e.g., "Ātmā jāgo re…")
   - NEVER use macrons (ī, ū, ṛ, ṅ, etc.) in prose.
   - In prose: prapti, bhakti, anand, murti (no diacritics).

4. MANDATORY TERMINOLOGY:
   - mandir (NEVER "temple")
   - Swami / Swamis (NEVER "saint" / "sadhu")
   - devotee(s) (not "haribhakta")
   - Akshardham (NEVER "divine abode")
   - Shriji Maharaj (two words — NEVER "Shrijimaharaj")
   - Bhagwan Swaminarayan (not "Lord Swaminarayan")
   - Mahant Swami Maharaj → Swamishri (after first reference)
   - Pramukh Swami Maharaj → Swamishri (after first reference)
   - austerities (not "penance")
   - mukhpath (not "recitation")
   - shastra (not "scripture" in spiritual context)
   - seva (not "service" in spiritual context)
   - satsang (not "fellowship")
   - santmandal (for a collective group of saints)
   - paramhansa, bawa, arti, vichran (BAPS standard spellings)
   - brahmisthiti (not "Brahmic state")
   - successor (not "torchbearer")
   - Naran'da (short form — consistent)
   - arti (not "aarti" — single a)

5. PLACE NAMES (EXACT SPELLINGS):
   Chansad, Bamangam, Dhuliya, Dangara, Bhadrod, Piplana

6. HISTORICAL INTEGRITY:
   - Preserve exact dates, exact time stamps (e.g. 2.16 a.m.), all numbers.
   - Never approximate unless the source approximates.
   - Historical names: use era-correct names (e.g., "Bombay Province" not "Mumbai").
   - Never infer inner thoughts unless the source documents them.

7. TONE: Dignified, measured, reverent, clear, intellectually honest.
   - Never: hype, dramatic exaggeration, "life-changing", "BAPS is proud…"
   - Never: casual register, American marketing tone.
   - Never: "mythology" for Hindu texts (use "scripture" or "sacred history").
   - Never: modern management terms (CEO, strategy, etc.) in historical contexts.

8. TRANSLATION FIDELITY:
   - Preserve meaning, sequence, theology, emotional tone.
   - Do NOT add interpretation not present in source.
   - Do NOT paraphrase or summarise — translate fully, line by line.
   - Do NOT soften strong expressions.
   - Retain direct quotes in first person; never convert to indirect speech.

9. POETRY & VERSE:
   - Include Roman transliteration FIRST, then English meaning.
   - Retain original Gujarati/Sanskrit verse line intact.
   - Use ā diacritics only within quoted verse.
   - Italicise transliterated verses.

10. FORMATTING:
    - Preserve all paragraph breaks from source.
    - No headers unless present in source.
    - Italicise book titles.
    - Do not add ellipsis to truncate verse — reproduce in full.`;

const KEY_GLOSSARY = `
KEY THEOLOGICAL GLOSSARY (use these exact English renderings):
akshar: Imperishable; second-highest of five eternal realities
Aksharbrahmma: See Akshar
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

// ─── System Prompts (based on Gold Standard Prompts) ─────────────────────────

// PROMPT 1 (Chunker): Structural splitter
const CHUNKER_SYSTEM = `You are a structural analyst for Gujarati sacred texts. Split text at natural paragraph and verse boundaries into chunks of at most 500 words. Never break mid-sentence, mid-verse, or mid-quotation. If a chapter heading is present, always start a new chunk at the heading. Return ONLY valid JSON — no markdown fences.`;

// PROMPT 2 (Translator): Trustee of tradition mindset
const TRANSLATOR_SYSTEM = `You are a trustee of tradition (parampara) for Aksharpith, the publishing wing of BAPS Swaminarayan Sanstha. Your priority is FIDELITY OVER FLUENCY. You are a carrier of the original voice — not a commentator, not an editor.

I have locked in these rules:

${HOUSE_RULES_CONTEXT}

${KEY_GLOSSARY}

MINDSET: You are translating sacred biographical and historical Gujarati texts. Every sentence carries devotional, historical, and doctrinal weight. Preserve it completely. Provide ONLY the English translation — no preamble, no notes, no commentary.`;

// PROMPT 3 (Reviewer): Checks against house style + correction examples
const REVIEWER_SYSTEM = `You are a senior editorial reviewer for Aksharpith publications. You check Gujarati-to-English translations against the house style and BAPS correction standards.

${HOUSE_RULES_CONTEXT}

CRITICAL CORRECTIONS FROM MASTER LEARNING DOCUMENT:
- "saints" → must be "Swamis" or "Swami"
- "temple" → must be "mandir"
- "divine abode" → must be "Akshardham"
- "Shrijimaharaj" → must be "Shriji Maharaj" (two words)
- "mythology" → must be "scripture" or "sacred history"
- "penance" → must be "austerities"
- "haribhaktas" → must be "devotees"
- "torchbearer" → must be "successor"
- "aarti" → must be "arti"
- "vicharan" → must be "vichran"
- "Chanasad" → "Chansad" | "Bamangaon" → "Bamangam" | "Dungara" → "Dangara"
- Direct speech must stay first-person; never convert to indirect
- All poetic lines must include transliteration + English meaning
- Straight quotes " " → must be curly " "
- Em dash — → must be spaced en dash –

Score 0–100. Return ONLY valid JSON — no markdown fences, no prose outside JSON.`;

// PROMPT 4 (Smoother): Readability pass
const SMOOTHER_SYSTEM = `You are a senior editorial reader for Aksharpith publications performing a final readability pass on a completed translation.

WHAT TO IMPROVE:
- Smooth awkward phrasing and unnatural flow in narrative prose
- Restructure overly long or heavily nested sentences
- Add natural transitions between paragraphs where the English feels abrupt
- Remove repetitive sentence openings

WHAT TO NEVER CHANGE:
- Direct quotes from any named historical figure, scholar, or Swami — leave these WORD FOR WORD
- Transliterated verses and their translations — reproduce in full, never truncate
- All proper nouns, Sanskrit/Gujarati terms, place names, personal names
- All dates, numbers, time stamps

STYLE:
- En dash ( – ) throughout; NEVER em dash
- British English, Oxford -ize (recognize, organize, realize)
- Italicise transliterated verses and book titles
- Curly double speech marks " " — never straight quotes
- Reverent, dignified, measured tone

Return ONLY the revised text — no preamble, no notes.`;

// PROMPT 5 (Assembler): Final book assembly
const ASSEMBLER_SYSTEM = `You are a senior editor for Aksharpith publications assembling a multi-chunk translation into a single, coherent, publication-ready English document.

Rules:
- Remove all chunk markers, separators, and numbering
- Ensure smooth transitions at chunk joins
- Preserve chapter headings exactly as they appear
- Maintain consistent British English, Oxford style, and reverent scholarly tone
- Preserve all paragraph breaks, verse quotations, and block quotations exactly
- Output ONLY the final assembled document — no preamble or notes`;

// ─── Agent functions ────────────────────────────────────────────────────────────

async function chunkerAgent(apiKey: string, text: string): Promise<string[]> {
  const raw = await callClaude({
    model: 'claude-sonnet-4-20250514', max_tokens: 4096, apiKey,
    system: CHUNKER_SYSTEM,
    messages: [{ role: 'user', content: `Split this Gujarati text into chunks of at most 500 words, splitting ONLY at natural paragraph or verse boundaries (blank lines). Return JSON exactly as: {"chunks": ["chunk1 text", "chunk2 text", ...]}\n\nTEXT:\n${text}` }],
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [text];
  try {
    const p = JSON.parse(match[0]);
    const chunks = Array.isArray(p.chunks) ? p.chunks.filter((c: unknown) => typeof c === 'string' && (c as string).trim()) : [];
    return chunks.length > 0 ? chunks : [text];
  } catch { return [text]; }
}

async function translatorAgent(
  apiKey: string, chunk: string,
  translationMemory: string, chunkIndex: number, totalChunks: number,
): Promise<string> {
  const memorySection = translationMemory ? `\nTRANSLATION MEMORY (decisions made in previous chunks — maintain consistency):\n${translationMemory}\n\n${'─'.repeat(60)}\n` : '';
  return callClaude({
    model: 'claude-sonnet-4-20250514', max_tokens: 4096, apiKey,
    system: TRANSLATOR_SYSTEM,
    messages: [{ role: 'user', content: `${memorySection}Chunk ${chunkIndex + 1} of ${totalChunks}. Translate the following Gujarati text to English. Provide ONLY the translation.\n\nGUJARATI:\n${chunk}` }],
  });
}

interface ReviewResult { score: number; issues: string[]; revised: string; }

async function reviewerAgent(
  apiKey: string, original: string, translation: string,
): Promise<ReviewResult> {
  const raw = await callClaude({
    model: 'claude-sonnet-4-20250514', max_tokens: 8192, apiKey,
    system: REVIEWER_SYSTEM,
    messages: [{ role: 'user', content: `ORIGINAL (Gujarati):\n${original}\n\nTRANSLATION TO REVIEW:\n${translation}\n\nReturn JSON:\n{"score": <integer 0-100>, "issues": ["issue 1", ...], "revised": "<corrected translation or identical if no changes>"}` }],
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { score: 70, issues: [], revised: translation };
  try {
    const p = JSON.parse(match[0]);
    return {
      score:   typeof p.score   === 'number' ? Math.max(0, Math.min(100, p.score)) : 70,
      issues:  Array.isArray(p.issues)        ? p.issues.filter((s: unknown) => typeof s === 'string') : [],
      revised: typeof p.revised === 'string' && p.revised.trim() ? p.revised.trim() : translation,
    };
  } catch { return { score: 70, issues: [], revised: translation }; }
}

async function smootherAgent(apiKey: string, text: string): Promise<string> {
  return callClaude({
    model: 'claude-sonnet-4-20250514', max_tokens: 8192, apiKey,
    system: SMOOTHER_SYSTEM,
    messages: [{ role: 'user', content: `Perform the readability pass on the following translation. Return ONLY the revised text.\n\n${text}` }],
  });
}

async function assemblerAgent(apiKey: string, smoothedChunks: string[]): Promise<string> {
  const combined = smoothedChunks.join('\n\n');
  if (smoothedChunks.length === 1) return combined;
  return callClaude({
    model: 'claude-sonnet-4-20250514', max_tokens: 16000, apiKey,
    system: ASSEMBLER_SYSTEM,
    messages: [{ role: 'user', content: `Assemble these translated chunks into a single coherent document.\n\n${combined}` }],
  });
}

// Extract proper noun decisions from a translation for cross-chunk memory
async function extractTranslationMemory(apiKey: string, gujarati: string, english: string): Promise<string> {
  const raw = await callClaude({
    model: 'claude-haiku-4-5-20251001', max_tokens: 512, apiKey,
    system: 'You extract proper noun translation decisions from Gujarati→English translations. Return a concise bulleted list of name/term decisions, e.g. "• ગઢડા → Gadhada". Only include non-obvious decisions. If nothing notable, return an empty string. No JSON, no preamble.',
    messages: [{ role: 'user', content: `Gujarati source:\n${gujarati.slice(0, 500)}\n\nEnglish translation:\n${english.slice(0, 500)}\n\nList any proper noun / term decisions made:` }],
  });
  return raw.trim();
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { text, chapterTitle } = body as { text?: string; chapterTitle?: string };

  if (!text?.trim()) {
    return new Response(JSON.stringify({ error: 'No text provided' }), { status: 400 });
  }

  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount > 50000) {
    return new Response(JSON.stringify({ error: `Section too long (${wordCount.toLocaleString()} words). Maximum is 50,000 words. Upload the full document and use book mode to process chapter by chapter.` }), { status: 400 });
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

      // Keep the SSE connection alive during long Claude API calls.
      // Vercel's proxy closes idle connections after ~20s with no data.
      const keepalive = (fn: () => Promise<void>) => {
        const interval = setInterval(() => {
          try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { /* stream closed */ }
        }, 10000);
        return fn().finally(() => clearInterval(interval));
      };

      try {
        const context = chapterTitle ? ` — ${chapterTitle}` : '';

        // ── Stage 1: Chunker ───────────────────────────────────────────
        send({ stage: 'chunker', status: 'running' });
        let chunks: string[] = [];
        await keepalive(async () => { chunks = await chunkerAgent(apiKey, text); });
        send({ stage: 'chunker', status: 'done', count: chunks.length, chunks, context });

        // ── Stage 2: Translator (with cross-chunk memory) ──────────────
        send({ stage: 'translator', status: 'running' });
        const translations: string[] = [];
        let translationMemory = '';

        for (let i = 0; i < chunks.length; i++) {
          let translation = '';
          await keepalive(async () => { translation = await translatorAgent(apiKey, chunks[i], translationMemory, i, chunks.length); });
          translations.push(translation);
          send({ stage: 'translator', status: 'progress', current: i + 1, total: chunks.length, index: i, translation });
          // Update cross-chunk memory asynchronously (don't await — update on next chunk)
          if (i < chunks.length - 1) {
            extractTranslationMemory(apiKey, chunks[i], translation)
              .then(mem => { if (mem) translationMemory = (translationMemory + '\n' + mem).trim().slice(-2000); })
              .catch(() => {});
          }
        }
        send({ stage: 'translator', status: 'done', memorySize: translationMemory.length });

        // ── Stage 3: Reviewer ──────────────────────────────────────────
        send({ stage: 'reviewer', status: 'running' });
        const reviews: ReviewResult[] = [];

        for (let i = 0; i < chunks.length; i++) {
          let review: ReviewResult = { score: 70, issues: [], revised: translations[i] };
          await keepalive(async () => { review = await reviewerAgent(apiKey, chunks[i], translations[i]); });
          reviews.push(review);
          send({ stage: 'reviewer', status: 'progress', chunk: i + 1, total: chunks.length, index: i, score: review.score, issues: review.issues, revised: review.revised });
        }

        const avgScore = reviews.reduce((s, r) => s + r.score, 0) / reviews.length;
        send({ stage: 'reviewer', status: 'done', avgScore });

        // ── Stage 4: Smoother (Prompt 4 — readability pass) ───────────
        send({ stage: 'smoother', status: 'running' });
        const smoothedChunks: string[] = [];

        for (let i = 0; i < reviews.length; i++) {
          let smoothed = '';
          await keepalive(async () => { smoothed = await smootherAgent(apiKey, reviews[i].revised); });
          smoothedChunks.push(smoothed);
          send({ stage: 'smoother', status: 'progress', current: i + 1, total: reviews.length, index: i });
        }
        send({ stage: 'smoother', status: 'done' });

        // ── Stage 5: Assembler ─────────────────────────────────────────
        send({ stage: 'assembler', status: 'running' });
        let assembled = '';
        await keepalive(async () => { assembled = await assemblerAgent(apiKey, smoothedChunks); });
        const finalWords = assembled.trim().split(/\s+/).length;
        send({ stage: 'assembler', status: 'done', output: assembled, wordCount: finalWords, avgScore: Math.round(avgScore) });

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        console.error('Pipeline error:', msg);
        send({ error: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':       'text/event-stream',
      'Cache-Control':      'no-cache, no-transform',
      'Connection':         'keep-alive',
      'X-Accel-Buffering':  'no',
    },
  });
}
