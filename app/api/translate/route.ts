import https from 'node:https';
import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';
import {
  PROTECTED_TERMS,
  TERMINOLOGY_RULES,
  PERSONAL_NAME_RULES,
  PLACE_NAME_RULES,
  DIACRITICS_MAP,
  buildTranslatorSystem,
  buildReviewerSystem,
  buildSmootherSystem,
  buildAssemblerSystem,
} from '../../../lib/rules';
import type { RulesCorrection } from '../../../lib/rules';

export const dynamic    = 'force-dynamic';
export const maxDuration = 300;

// ─── Config ──────────────────────────────────────────────────────────────────

const SONNET = 'claude-sonnet-4-20250514';
const BATCH  = 5;                // parallel chunk concurrency
const RECHECK_THRESHOLD = 96;   // re-review chunks scoring below this on weighted rubric score
const MAX_REVIEW_ROUNDS = 2;    // max iterative review rounds per chunk (keep at 2 for Vercel 300s limit)
const API_TIMEOUT_MS    = 90_000;  // 90s per Claude call (tighter for Vercel)
const MAX_RETRIES       = 1;      // single retry to stay within time budget

// ─── Build prompts once ──────────────────────────────────────────────────────

const TRANSLATOR_SYSTEM = buildTranslatorSystem();
const REVIEWER_SYSTEM   = buildReviewerSystem();
const SMOOTHER_SYSTEM   = buildSmootherSystem(PROTECTED_TERMS);
const ASSEMBLER_SYSTEM  = buildAssemblerSystem(PROTECTED_TERMS);

// ─── Anthropic API helper (with timeout + retry) ────────────────────────────

function callClaudeOnce(params: {
  model: string; max_tokens: number; system: string;
  messages: Array<{ role: string; content: string }>; apiKey: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use prompt caching: send system as a cacheable content block
    const body = JSON.stringify({
      model: params.model, max_tokens: params.max_tokens,
      system: [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }],
      messages: params.messages,
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': params.apiKey, 'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
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
          const data = JSON.parse(raw) as { content?: Array<{ type: string; text?: string }>; usage?: Record<string, number> };
          const text = data.content?.[0]?.text?.trim();
          if (!text) { reject(new Error('Empty response from Anthropic API')); return; }
          // Log cache hits for cost monitoring
          if (data.usage) {
            const u = data.usage;
            const cached = u.cache_read_input_tokens ?? 0;
            const created = u.cache_creation_input_tokens ?? 0;
            if (cached > 0 || created > 0) {
              console.log(`[cache] model=${params.model} cached=${cached} created=${created} input=${u.input_tokens ?? 0} output=${u.output_tokens ?? 0}`);
            }
          }
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

// ─── Deterministic chunker ─────────────────────────────────────────────────

function isVerseBlock(para: string): boolean {
  const lines = para.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const quotedVerse = lines.some(l => /^[\u201c\u201d"'\u2018\u2019]/.test(l) && /[āīūṛṅñṭḍṇśṣḥ]/.test(l));
  const avgLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
  const similarLength = lines.length >= 2 && lines.every(l => Math.abs(l.length - avgLen) < avgLen * 0.5);
  const diacriticLines = lines.filter(l => /[āīūṛṅñṭḍṇśṣḥ]/.test(l)).length;
  const mostlyDiacritic = diacriticLines >= lines.length * 0.5;
  return quotedVerse || (similarLength && mostlyDiacritic);
}

function deterministicChunk(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const totalWords = trimmed.split(/\s+/).filter(Boolean).length;
  if (totalWords <= 500) return [trimmed];

  let rawParagraphs = trimmed.split(/\n\s*\n/);
  const hasGiantPara = rawParagraphs.some(p => p.trim().split(/\s+/).length > 500);
  if (hasGiantPara) {
    rawParagraphs = trimmed.split(/\n/).filter(l => l.trim());
  }
  const paragraphs = rawParagraphs;

  const groups: string[] = [];
  let pendingVerse: string | null = null;
  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    if (isVerseBlock(p)) {
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

// ─── Agent functions ────────────────────────────────────────────────────────

function chunkerAgent(_apiKey: string, text: string): Promise<string[]> {
  return Promise.resolve(deterministicChunk(text));
}

async function translatorAgent(
  apiKey: string, chunk: string, chunkIndex: number, totalChunks: number,
): Promise<string> {
  return callClaude({
    model: SONNET, max_tokens: 8192, apiKey,
    system: TRANSLATOR_SYSTEM,
    messages: [{ role: 'user', content: `Chunk ${chunkIndex + 1} of ${totalChunks}. Translate the following Gujarati text to English. Provide ONLY the translation.\n\nGUJARATI:\n${chunk}` }],
  });
}

interface ReviewResult {
  categories: Array<{ id: string; weight: number; score: number; deductions: string[]; pass: boolean }>;
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
      model: SONNET, max_tokens: 16000, apiKey,
      system: REVIEWER_SYSTEM,
      messages: [{ role: 'user', content: `GUJARATI SOURCE:\n${original}\n\nTRANSLATION TO AUDIT:\n${translation}` }],
    });
  } catch (err) {
    console.error('Reviewer API call failed:', err instanceof Error ? err.message : err);
    return fallback;
  }

  const stripped = raw.replace(/^```(?:json)?\s*/gm, '').replace(/\s*```$/gm, '');
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('Reviewer returned no JSON object. Raw response (first 500 chars):', raw.slice(0, 500));
    return fallback;
  }

  const jsonStr = match[0];

  try {
    const p = JSON.parse(jsonStr);
    const rawScore = typeof p.totalScore === 'number' ? p.totalScore : (typeof p.score === 'number' ? p.score : 50);
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
    console.error('Reviewer JSON parse failed (likely truncated). Attempting partial extraction. Raw length:', raw.length, 'First 300 chars:', raw.slice(0, 300));

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

    let revised = translation;
    const revisedMatch = jsonStr.match(/"revised"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
    if (revisedMatch && revisedMatch[1].trim().length > 50) {
      try {
        revised = JSON.parse(`"${revisedMatch[1]}"`);
      } catch {
        revised = translation;
      }
    }

    let certifiable = false;
    const certMatch = jsonStr.match(/"certifiable"\s*:\s*(true|false)/);
    if (certMatch) {
      certifiable = certMatch[1] === 'true';
    }

    let categories: ReviewResult['categories'] = [];
    try {
      const catMatch = jsonStr.match(/"categories"\s*:\s*\[[\s\S]*?\]/);
      if (catMatch) {
        categories = JSON.parse(catMatch[0].replace(/^"categories"\s*:\s*/, ''));
      }
    } catch { /* ignore */ }

    let pitfalls: string[] = [];
    try {
      const pitMatch = jsonStr.match(/"pitfalls"\s*:\s*\[[\s\S]*?\]/);
      if (pitMatch) {
        pitfalls = JSON.parse(pitMatch[0].replace(/^"pitfalls"\s*:\s*/, '')).filter((s: unknown) => typeof s === 'string');
      }
    } catch { /* ignore */ }

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

// ─── Rules Enforcer (deterministic 6th stage) ─────────────────────────────────

function rulesEnforcerAgent(text: string): { text: string; corrections: RulesCorrection[]; totalFixes: number } {
  const corrections: RulesCorrection[] = [];
  let t = text;

  function apply(pattern: RegExp, replacement: string | ((m: string) => string), rule: string) {
    let count = 0;
    const before = t;
    if (typeof replacement === 'string') {
      t = t.replace(pattern, () => { count++; return replacement; });
    } else {
      t = t.replace(pattern, (m: string) => { count++; return replacement(m); });
    }
    if (count > 0) {
      const sampleMatch = before.match(pattern);
      const from = sampleMatch ? sampleMatch[0] : pattern.source;
      const to = typeof replacement === 'string' ? replacement : replacement(from);
      corrections.push({ from, to, rule, count });
    }
  }

  // ═══ TERMINOLOGY RULES ═══
  for (const rule of TERMINOLOGY_RULES) {
    apply(rule.pattern, rule.replacement, rule.rule);
  }

  // ═══ PERSONAL NAME CORRECTIONS ═══
  for (const rule of PERSONAL_NAME_RULES) {
    apply(rule.pattern, rule.replacement, rule.rule);
  }

  // ═══ PLACE NAME CORRECTIONS ═══
  for (const rule of PLACE_NAME_RULES) {
    apply(rule.pattern, rule.replacement, rule.rule);
  }

  // ═══ PUNCTUATION RULES ═══
  // Straight double quotes → curly (paired)
  let openDouble = true;
  const beforeQuotes = t;
  t = t.replace(/"/g, () => { const q = openDouble ? '\u201c' : '\u201d'; openDouble = !openDouble; return q; });
  if (t !== beforeQuotes) {
    const count = (beforeQuotes.match(/"/g) || []).length;
    corrections.push({ from: '"', to: '\u201c/\u201d', rule: 'straight quotes\u2192curly quotes', count });
  }
  // Straight single quotes → curly (paired, not apostrophes)
  const beforeSingle = t;
  t = t.replace(/'([^']{2,})'/g, '\u2018$1\u2019');
  if (t !== beforeSingle) corrections.push({ from: "'x'", to: '\u2018x\u2019', rule: 'straight single quotes\u2192curly', count: 1 });

  // ═══ DASH RULES ═══
  const beforeDash = t;
  t = t.replace(/\u2014/g, ' \u2013 ');
  t = t.replace(/ {2,}\u2013 {2,}/g, ' \u2013 ');
  if (t !== beforeDash) corrections.push({ from: '\u2014', to: ' \u2013 ', rule: 'em dash\u2192spaced en dash', count: (beforeDash.match(/\u2014/g) || []).length });

  // ═══ DIACRITICS RULES ═══
  for (const [from, to] of Object.entries(DIACRITICS_MAP)) {
    const beforeDiac = t;
    t = t.split(from).join(to);
    if (t !== beforeDiac) {
      const count = beforeDiac.split(from).length - 1;
      corrections.push({ from, to, rule: `forbidden diacritics stripped (only \u0101 permitted)`, count });
    }
  }

  const totalFixes = corrections.reduce((s, c) => s + c.count, 0);
  return { text: t, corrections, totalFixes };
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

  const apiKey: string | undefined = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500 });
  }
  const key: string = apiKey;

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
        const chunks = await chunkerAgent(key, text);
        if (chunks.length === 0) { send({ error: 'No content to translate' }); return; }
        send({ stage: 'chunker', status: 'done', count: chunks.length, chunks, context });

        // ── Stages 2-4: Pipelined per-chunk processing ──────────────────
        const translations: string[] = new Array(chunks.length).fill('');
        const reviews: ReviewResult[] = new Array(chunks.length);
        const smoothedChunks: string[] = new Array(chunks.length).fill('');

        // chunkData for training export
        const chunkDataForStorage: Array<{
          index: number;
          originalGujarati: string;
          translation: string;
          reviewerScore: number;
          reviewerCategories: Array<{ id: string; score: number; weight: number }>;
          certifiable: boolean;
        }> = [];

        let translateDone = 0, reviewDone = 0, smoothDone = 0;
        let translatorStarted = false, reviewerStarted = false, smootherStarted = false;
        let translatorFinished = false, reviewerFinished = false, smootherFinished = false;
        let totalRechecks = 0;
        let smootherFlagged = 0;

        async function processChunk(i: number) {
          if (!translatorStarted) { translatorStarted = true; send({ stage: 'translator', status: 'running' }); }
          translations[i] = rulesEnforcerAgent(await translatorAgent(key, chunks[i], i, chunks.length)).text;
          translateDone++;
          send({ stage: 'translator', status: 'progress', current: translateDone, total: chunks.length, index: i, translation: translations[i] });
          if (translateDone === chunks.length && !translatorFinished) {
            translatorFinished = true;
            send({ stage: 'translator', status: 'done', memorySize: 0 });
          }

          if (!reviewerStarted) { reviewerStarted = true; send({ stage: 'reviewer', status: 'running' }); }
          reviews[i] = await reviewerAgent(key, chunks[i], translations[i]);
          send({ stage: 'reviewer', status: 'progress', completed: reviewDone + 1, total: chunks.length, index: i, categories: reviews[i].categories, pitfalls: reviews[i].pitfalls, issues: reviews[i].issues, score: reviews[i].score, certifiable: reviews[i].certifiable });

          for (let round = 1; round <= MAX_REVIEW_ROUNDS && reviews[i].score < RECHECK_THRESHOLD; round++) {
            totalRechecks++;
            reviews[i] = await reviewerAgent(key, chunks[i], reviews[i].revised);
            send({ stage: 'reviewer', status: 'progress', completed: reviewDone, total: chunks.length, index: i, categories: reviews[i].categories, pitfalls: reviews[i].pitfalls, issues: reviews[i].issues, score: reviews[i].score, certifiable: reviews[i].certifiable, recheck: true, round });
          }

          reviewDone++;
          if (reviewDone === chunks.length && !reviewerFinished) {
            reviewerFinished = true;
            const certCount = reviews.filter(r => r.certifiable).length;
            const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;
            send({ stage: 'reviewer', status: 'done', certCount, total: chunks.length, avgScore, rechecked: totalRechecks });
          }

          // Store chunk data for training export
          chunkDataForStorage.push({
            index: i,
            originalGujarati: chunks[i],
            translation: reviews[i].revised,
            reviewerScore: reviews[i].score,
            reviewerCategories: reviews[i].categories.map(c => ({ id: c.id, score: c.score, weight: c.weight })),
            certifiable: reviews[i].certifiable,
          });

          if (!smootherStarted) { smootherStarted = true; send({ stage: 'smoother', status: 'running' }); }
          const smoothResult = await smootherAgent(key, reviews[i].revised);
          const chunkEnforced = rulesEnforcerAgent(smoothResult.text);
          smoothedChunks[i] = chunkEnforced.text;
          if (smoothResult.flagged) smootherFlagged++;
          smoothDone++;
          send({ stage: 'smoother', status: 'progress', completed: smoothDone, total: chunks.length, index: i, flagged: smoothResult.flagged });
          if (smoothDone === chunks.length && !smootherFinished) {
            smootherFinished = true;
            send({ stage: 'smoother', status: 'done', flaggedChunks: smootherFlagged });
          }
        }

        const allChunks = Array.from({ length: chunks.length }, (_, i) => i);
        await parallelBatch(allChunks, async (i) => processChunk(i), BATCH);

        if (!translatorFinished) { translatorFinished = true; send({ stage: 'translator', status: 'done', memorySize: 0 }); }
        if (!reviewerFinished) {
          reviewerFinished = true;
          const certCount = reviews.filter(r => r.certifiable).length;
          const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;
          send({ stage: 'reviewer', status: 'done', certCount, total: chunks.length, avgScore, rechecked: totalRechecks });
        }
        if (!smootherFinished) {
          smootherFinished = true;
          send({ stage: 'smoother', status: 'done', flaggedChunks: smootherFlagged });
        }

        // ── Stage 5: Assembler (Sonnet) ─────────────────────────────────
        const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;
        send({ stage: 'assembler', status: 'running' });
        const assembled = await assemblerAgent(key, smoothedChunks);
        send({ stage: 'assembler', status: 'done' });

        // ── Stage 6: Rules Enforcer (deterministic — no LLM) ─────────────
        send({ stage: 'enforcer', status: 'running' });
        const enforced = rulesEnforcerAgent(assembled);
        const finalText = enforced.text;
        const finalWords = finalText.trim().split(/\s+/).filter(Boolean).length;
        send({
          stage: 'enforcer', status: 'done',
          output: finalText, wordCount: finalWords, avgScore: Math.round(avgScore),
          totalFixes: enforced.totalFixes,
          corrections: enforced.corrections.map(c => ({ from: c.from, to: c.to, rule: c.rule, count: c.count })),
        });

        // Save to Firestore (with translationId for reviews + training export)
        try {
          const docRef = await adminDb.collection('translations').add({
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
            output: finalText,
            inputPreview: text.slice(0, 300),
            chunkData: chunkDataForStorage.sort((a, b) => a.index - b.index),
            createdAt: new Date().toISOString(),
          });
          // Emit translationId so the client can use it for reviews/export
          send({ translationId: docRef.id });
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
