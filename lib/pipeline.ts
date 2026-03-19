import https from 'node:https';
import {
  PROTECTED_TERMS,
  TERMINOLOGY_RULES,
  PERSONAL_NAME_RULES,
  PLACE_NAME_RULES,
  FORBIDDEN_VOCAB_RULES,
  HEDGING_RULES,
  DATE_FORMAT_RULES,
  DIACRITICS_MAP,
  buildTranslatorSystem,
  buildReviewerSystem,
  buildSmootherSystem,
} from './rules';
import type { RulesCorrection } from './rules';
import type { PipelineInput, PipelineAuth, ProgressReporter, ChunkProgress, JobProgress } from './job-types';

// ─── Config ──────────────────────────────────────────────────────────────────

const SONNET = 'claude-sonnet-4-20250514';
const BATCH  = 5;
const RECHECK_THRESHOLD = 96;
const MAX_REVIEW_ROUNDS = 2;
const API_TIMEOUT_MS    = 90_000;
const MAX_RETRIES       = 1;

// ─── Build prompts once ──────────────────────────────────────────────────────

const TRANSLATOR_SYSTEM = buildTranslatorSystem();
const REVIEWER_SYSTEM   = buildReviewerSystem();
const SMOOTHER_SYSTEM   = buildSmootherSystem(PROTECTED_TERMS);

// ─── Anthropic API helper ────────────────────────────────────────────────────

function callClaudeOnce(params: {
  model: string; max_tokens: number; system: string;
  messages: Array<{ role: string; content: string }>; apiKey: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
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

// ─── Parallel batch helper ──────────────────────────────────────────────────

async function parallelBatch<T>(
  items: T[], fn: (item: T, index: number) => Promise<void>, batchSize: number,
): Promise<void> {
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const results = await Promise.allSettled(batch.map((item, bi) => fn(item, start + bi)));
    const firstFailure = results.find(r => r.status === 'rejected');
    if (firstFailure && firstFailure.status === 'rejected') throw firstFailure.reason;
  }
}

// ─── Deterministic chunker ──────────────────────────────────────────────────

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

  const groups: string[] = [];
  let pendingVerse: string | null = null;
  for (const para of rawParagraphs) {
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

async function translatorAgent(
  apiKey: string, chunk: string, chunkIndex: number, totalChunks: number,
): Promise<string> {
  return callClaude({
    model: SONNET, max_tokens: 8192, apiKey,
    system: TRANSLATOR_SYSTEM,
    messages: [{ role: 'user', content: `Chunk ${chunkIndex + 1} of ${totalChunks}. Translate the following Gujarati text to English. For any verse or poetry, you MUST include the Roman transliteration in curly quotes first, then the English meaning in parentheses — both are mandatory. Provide ONLY the translated output (no preamble or notes).\n\nGUJARATI:\n${chunk}` }],
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
    console.error('Reviewer returned no JSON object. Raw (first 500):', raw.slice(0, 500));
    return fallback;
  }

  const jsonStr = match[0];

  try {
    const p = JSON.parse(jsonStr);
    const rawScore = typeof p.totalScore === 'number' ? p.totalScore : (typeof p.score === 'number' ? p.score : 50);
    const cats: ReviewResult['categories'] = Array.isArray(p.categories)
      ? p.categories.map((c: Record<string, unknown>) => ({
          id: typeof c.id === 'string' ? c.id : '',
          weight: typeof c.weight === 'number' ? c.weight : 0,
          score: typeof c.score === 'number' ? Math.max(0, c.score as number) : 0,
          deductions: Array.isArray(c.deductions) ? (c.deductions as unknown[]).filter((s: unknown) => typeof s === 'string') as string[] : (Array.isArray(c.issues) ? (c.issues as unknown[]).filter((s: unknown) => typeof s === 'string') as string[] : []),
          pass: typeof c.pass === 'boolean' ? c.pass : true,
        }))
      : [];
    return {
      categories: cats,
      pitfalls: Array.isArray(p.pitfalls) ? p.pitfalls.filter((s: unknown) => typeof s === 'string') : [],
      issues: Array.isArray(p.issues) ? p.issues.filter((s: unknown) => typeof s === 'string') : [],
      score: Math.max(0, Math.min(100, rawScore)),
      revised: typeof p.revised === 'string' && p.revised.trim() ? p.revised.trim() : translation,
      certifiable: typeof p.certifiable === 'boolean' ? p.certifiable : false,
    };
  } catch {
    console.error('Reviewer JSON parse failed. Raw length:', raw.length);
    let score = 50;
    const tsm = jsonStr.match(/"totalScore"\s*:\s*(\d+)/);
    if (tsm) score = Math.max(0, Math.min(100, parseInt(tsm[1], 10)));
    else { const sm = jsonStr.match(/"score"\s*:\s*(\d+)/); if (sm) score = Math.max(0, Math.min(100, parseInt(sm[1], 10))); }

    let revised = translation;
    const rm = jsonStr.match(/"revised"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
    if (rm && rm[1].trim().length > 50) { try { revised = JSON.parse(`"${rm[1]}"`); } catch { revised = translation; } }

    let certifiable = false;
    const cm = jsonStr.match(/"certifiable"\s*:\s*(true|false)/);
    if (cm) certifiable = cm[1] === 'true';

    let categories: ReviewResult['categories'] = [];
    try { const m = jsonStr.match(/"categories"\s*:\s*\[[\s\S]*?\]/); if (m) categories = JSON.parse(m[0].replace(/^"categories"\s*:\s*/, '')); } catch { /* ignore */ }
    let pitfalls: string[] = [];
    try { const m = jsonStr.match(/"pitfalls"\s*:\s*\[[\s\S]*?\]/); if (m) pitfalls = JSON.parse(m[0].replace(/^"pitfalls"\s*:\s*/, '')).filter((s: unknown) => typeof s === 'string'); } catch { /* ignore */ }
    let issues: string[] = [];
    try { const m = jsonStr.match(/"issues"\s*:\s*\[[\s\S]*?\]/); if (m) issues = JSON.parse(m[0].replace(/^"issues"\s*:\s*/, '')).filter((s: unknown) => typeof s === 'string'); } catch { /* ignore */ }

    return { categories, pitfalls, issues, score, revised, certifiable };
  }
}

function charDiffRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  let diffs = Math.abs(a.length - b.length);
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) { if (a[i] !== b[i]) diffs++; }
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
    console.warn(`Smoother changed ${(diffRatio * 100).toFixed(1)}% of characters (>15%). Using original.`);
    return { text, flagged: true };
  }
  return { text: smoothed, flagged: false };
}

function assemblerAgent(smoothedChunks: string[]): string {
  if (smoothedChunks.length <= 1) return smoothedChunks[0] ?? '';
  const result: string[] = [];
  for (let i = 0; i < smoothedChunks.length; i++) {
    const chunk = smoothedChunks[i].trim();
    if (!chunk) continue;
    if (result.length > 0) {
      const prevSentences = result[result.length - 1].split(/(?<=[.!?])\s+/).filter(Boolean);
      const currSentences = chunk.split(/(?<=[.!?])\s+/).filter(Boolean);
      let overlap = 0;
      for (let n = Math.min(2, prevSentences.length, currSentences.length); n >= 1; n--) {
        if (prevSentences.slice(-n).join(' ').trim() === currSentences.slice(0, n).join(' ').trim()) { overlap = n; break; }
      }
      result.push(overlap > 0 ? currSentences.slice(overlap).join(' ') : chunk);
    } else {
      result.push(chunk);
    }
  }
  return result.join('\n\n');
}

// ─── Rules Enforcer ─────────────────────────────────────────────────────────

export function rulesEnforcerAgent(text: string): { text: string; corrections: RulesCorrection[]; totalFixes: number } {
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

  for (const rule of TERMINOLOGY_RULES) apply(rule.pattern, rule.replacement, rule.rule);
  for (const rule of PERSONAL_NAME_RULES) apply(rule.pattern, rule.replacement, rule.rule);
  for (const rule of PLACE_NAME_RULES) apply(rule.pattern, rule.replacement, rule.rule);
  for (const rule of FORBIDDEN_VOCAB_RULES) apply(rule.pattern, rule.replacement, rule.rule);
  for (const rule of HEDGING_RULES) apply(rule.pattern, rule.replacement, rule.rule);
  t = t.replace(/ {2,}/g, ' ').replace(/^ +/gm, '');
  for (const rule of DATE_FORMAT_RULES) apply(rule.pattern, rule.replacement, rule.rule);

  let openDouble = true;
  const bq = t;
  t = t.replace(/"/g, () => { const q = openDouble ? '\u201c' : '\u201d'; openDouble = !openDouble; return q; });
  if (t !== bq) corrections.push({ from: '"', to: '\u201c/\u201d', rule: 'straight quotes\u2192curly quotes', count: (bq.match(/"/g) || []).length });
  const bs = t;
  t = t.replace(/'([^']{2,})'/g, '\u2018$1\u2019');
  if (t !== bs) corrections.push({ from: "'x'", to: '\u2018x\u2019', rule: 'straight single quotes\u2192curly', count: 1 });

  const bd = t;
  t = t.replace(/\u2014/g, ' \u2013 ');
  t = t.replace(/ {2,}\u2013 {2,}/g, ' \u2013 ');
  if (t !== bd) corrections.push({ from: '\u2014', to: ' \u2013 ', rule: 'em dash\u2192spaced en dash', count: (bd.match(/\u2014/g) || []).length });

  for (const [from, to] of Object.entries(DIACRITICS_MAP)) {
    const before = t;
    t = t.split(from).join(to);
    if (t !== before) corrections.push({ from, to, rule: 'forbidden diacritics stripped (only \u0101 permitted)', count: before.split(from).length - 1 });
  }

  return { text: t, corrections, totalFixes: corrections.reduce((s, c) => s + c.count, 0) };
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

export async function runPipeline(
  input: PipelineInput,
  auth: PipelineAuth,
  reportProgress: ProgressReporter,
  adminDb: FirebaseFirestore.Firestore,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const { text, chapterTitle, bookId, bookTitle, chapterIndex, totalChapters } = input;

  // Helper to build chunk progress array
  const chunkProgressArr: ChunkProgress[] = [];

  // ── Stage 1: Chunker ──────────────────────────────────────────────────
  await reportProgress({ status: 'running', startedAt: new Date().toISOString(), progress: { currentStage: 'chunker', stages: { chunker: { status: 'running' } }, chunks: [] } });

  const chunks = deterministicChunk(text);
  if (chunks.length === 0) throw new Error('No content to translate');

  for (let i = 0; i < chunks.length; i++) {
    chunkProgressArr.push({ index: i, original: chunks[i].slice(0, 200) });
  }

  await reportProgress({ progress: { currentStage: 'translator', stages: { chunker: { status: 'done', chunkCount: chunks.length } }, chunks: chunkProgressArr } });

  // ── Stages 2-4: Pipelined per-chunk ───────────────────────────────────
  const translations: string[] = new Array(chunks.length).fill('');
  const reviews: ReviewResult[] = new Array(chunks.length);
  const smoothedChunks: string[] = new Array(chunks.length).fill('');

  const chunkDataForStorage: Array<{
    index: number; originalGujarati: string; translation: string;
    reviewerScore: number; reviewerCategories: Array<{ id: string; score: number; weight: number }>; certifiable: boolean;
  }> = [];

  let translateDone = 0, reviewDone = 0, smoothDone = 0;
  let totalRechecks = 0;
  let smootherFlagged = 0;

  async function processChunk(i: number) {
    // Translate
    translations[i] = rulesEnforcerAgent(await translatorAgent(apiKey!, chunks[i], i, chunks.length)).text;
    translateDone++;
    chunkProgressArr[i] = { ...chunkProgressArr[i], translation: translations[i].slice(0, 300) };

    // Review
    reviews[i] = await reviewerAgent(apiKey!, chunks[i], translations[i]);
    const chunkScoreHistory = [reviews[i].score];
    let chunkReviewRound = 1;
    for (let round = 1; round <= MAX_REVIEW_ROUNDS && reviews[i].score < RECHECK_THRESHOLD; round++) {
      totalRechecks++;
      chunkReviewRound++;
      reviews[i] = await reviewerAgent(apiKey!, chunks[i], reviews[i].revised);
      chunkScoreHistory.push(reviews[i].score);
    }
    reviewDone++;

    chunkProgressArr[i] = {
      ...chunkProgressArr[i],
      score: reviews[i].score,
      certifiable: reviews[i].certifiable,
      categories: reviews[i].categories,
      pitfalls: reviews[i].pitfalls,
      issues: reviews[i].issues,
      scoreHistory: chunkScoreHistory,
      reviewRound: chunkReviewRound,
    };

    chunkDataForStorage.push({
      index: i, originalGujarati: chunks[i], translation: reviews[i].revised,
      reviewerScore: reviews[i].score,
      reviewerCategories: reviews[i].categories.map(c => ({ id: c.id, score: c.score, weight: c.weight })),
      certifiable: reviews[i].certifiable,
    });

    // Smooth
    const smoothResult = await smootherAgent(apiKey!, reviews[i].revised);
    const chunkEnforced = rulesEnforcerAgent(smoothResult.text);
    smoothedChunks[i] = chunkEnforced.text;
    if (smoothResult.flagged) smootherFlagged++;
    smoothDone++;
    chunkProgressArr[i] = { ...chunkProgressArr[i], flagged: smoothResult.flagged };
  }

  // Process in batches — report progress after each batch
  const allChunkIndices = Array.from({ length: chunks.length }, (_, i) => i);
  for (let start = 0; start < allChunkIndices.length; start += BATCH) {
    const batch = allChunkIndices.slice(start, start + BATCH);
    const results = await Promise.allSettled(batch.map(i => processChunk(i)));
    const firstFailure = results.find(r => r.status === 'rejected');
    if (firstFailure && firstFailure.status === 'rejected') throw firstFailure.reason;

    // Report batch completion
    const currentStage = smoothDone === chunks.length ? 'assembler' : reviewDone > translateDone ? 'smoother' : translateDone > 0 ? 'reviewer' : 'translator';
    await reportProgress({
      progress: {
        currentStage,
        stages: {
          chunker: { status: 'done', chunkCount: chunks.length },
          translator: { status: translateDone >= chunks.length ? 'done' : 'running', completed: translateDone, total: chunks.length },
          reviewer: { status: reviewDone >= chunks.length ? 'done' : 'running', completed: reviewDone, total: chunks.length, rechecked: totalRechecks, certCount: reviews.filter(r => r?.certifiable).length, avgScore: reviewDone > 0 ? Math.round(reviews.filter(Boolean).reduce((s, r) => s + r.score, 0) / reviewDone) : 0 },
          smoother: { status: smoothDone >= chunks.length ? 'done' : 'running', completed: smoothDone, total: chunks.length, flaggedChunks: smootherFlagged },
        },
        chunks: chunkProgressArr,
      },
    });
  }

  // ── Stage 5: Assembler (deterministic) ────────────────────────────────
  await reportProgress({ progress: { currentStage: 'assembler', stages: { assembler: { status: 'running' } }, chunks: chunkProgressArr } });
  const assembled = assemblerAgent(smoothedChunks);
  await reportProgress({ progress: { currentStage: 'enforcer', stages: { assembler: { status: 'done' } }, chunks: chunkProgressArr } });

  // ── Stage 6: Rules Enforcer (deterministic) ───────────────────────────
  await reportProgress({ progress: { currentStage: 'enforcer', stages: { enforcer: { status: 'running' } }, chunks: chunkProgressArr } });
  const enforced = rulesEnforcerAgent(assembled);
  const finalText = enforced.text;
  const finalWords = finalText.trim().split(/\s+/).filter(Boolean).length;
  const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;

  const reviewerSummary = {
    avgScore: Math.round(avgScore),
    certifiedCount: reviews.filter(r => r.certifiable).length,
    totalChunks: chunks.length,
    categories: reviews.length > 0
      ? reviews[0].categories.map(cat => ({
          id: cat.id, weight: cat.weight,
          avgScore: Math.round(reviews.reduce((s, r) => s + (r.categories.find(c => c.id === cat.id)?.score ?? 0), 0) / reviews.length * 10) / 10,
        }))
      : [],
    totalDeductions: reviews.flatMap(r => r.categories.flatMap(c => c.deductions)).length,
    topIssues: reviews.flatMap(r => r.categories.flatMap(c => c.deductions)).slice(0, 10),
  };

  // Save to translations collection
  let translationId = '';
  try {
    const docRef = await adminDb.collection('translations').add({
      uid: auth.uid, email: auth.email,
      chapterTitle: chapterTitle || null, bookId: bookId || null, bookTitle: bookTitle || null,
      chapterIndex: chapterIndex ?? null, totalChapters: totalChapters ?? null,
      inputWordCount: input.wordCount, outputWordCount: finalWords,
      avgScore: Math.round(avgScore), output: finalText,
      inputPreview: text.slice(0, 300),
      chunkData: chunkDataForStorage.sort((a, b) => a.index - b.index),
      createdAt: new Date().toISOString(),
    });
    translationId = docRef.id;
  } catch (err) {
    console.error('Firestore save error:', err);
  }

  // Report completion
  await reportProgress({
    status: 'completed',
    completedAt: new Date().toISOString(),
    progress: {
      currentStage: 'enforcer',
      stages: { enforcer: { status: 'done', totalFixes: enforced.totalFixes } },
      chunks: chunkProgressArr,
    },
    result: {
      output: finalText, wordCount: finalWords, avgScore: Math.round(avgScore),
      totalFixes: enforced.totalFixes,
      corrections: enforced.corrections.map(c => ({ from: c.from, to: c.to, rule: c.rule, count: c.count })),
      reviewerSummary,
      translationId,
    },
  });
}
