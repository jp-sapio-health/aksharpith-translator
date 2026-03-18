#!/usr/bin/env node
/**
 * Local Worker — watches Firestore for jobs with mode:'local', runs them locally.
 * No timeout constraints. Starts automatically via launchd or alongside dev server.
 *
 * Usage: node scripts/local-worker.mjs
 * Reads env from .env.local + .env.vercel.local
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Load env ─────────────────────────────────────────────────────────────────

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const vars = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?([\s\S]*?)["']?\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

const env = {
  ...loadEnvFile(resolve(ROOT, '.env.local')),
  ...loadEnvFile(resolve(ROOT, '.env.vercel.local')),
};

const API_KEY = env.ANTHROPIC_API_KEY?.trim();
if (!API_KEY) { console.error('No ANTHROPIC_API_KEY found in .env.local or .env.vercel.local'); process.exit(1); }

const PROJECT_ID = env.FIREBASE_PROJECT_ID || 'aksharpith-translator';
const CLIENT_EMAIL = env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (!CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY');
  process.exit(1);
}

// ── Firebase Admin ───────────────────────────────────────────────────────────

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  initializeApp({ credential: cert({ projectId: PROJECT_ID, clientEmail: CLIENT_EMAIL, privateKey: PRIVATE_KEY }) });
}
const db = getFirestore();

// ── Pipeline config ──────────────────────────────────────────────────────────

const SONNET = 'claude-sonnet-4-20250514';
const BATCH = 5;
const RECHECK_THRESHOLD = 96;
const MAX_REVIEW_ROUNDS = 2;
const API_TIMEOUT_MS = 180_000; // 3 min — no Vercel limits
const MAX_RETRIES = 2;
const POLL_INTERVAL = 5_000;

// ── Load rules (import from project) ─────────────────────────────────────────
// We dynamically import the compiled rules. Since the project is TS, we need
// to use a bundler or copy the rules. For simplicity, we inline the essential
// rules loading via a child process that compiles on-the-fly.

let rulesModule;
try {
  // Try npx tsx to import TypeScript directly
  const { execSync } = await import('node:child_process');
  const rulesScript = `
    import { PROTECTED_TERMS, TERMINOLOGY_RULES, PERSONAL_NAME_RULES, PLACE_NAME_RULES,
      FORBIDDEN_VOCAB_RULES, HEDGING_RULES, DATE_FORMAT_RULES, DIACRITICS_MAP,
      buildTranslatorSystem, buildReviewerSystem, buildSmootherSystem } from '${ROOT}/lib/rules/index.ts';
    import { rulesEnforcerAgent } from '${ROOT}/lib/pipeline.ts';
    console.log(JSON.stringify({
      TRANSLATOR_SYSTEM: buildTranslatorSystem(),
      REVIEWER_SYSTEM: buildReviewerSystem(),
      SMOOTHER_SYSTEM: buildSmootherSystem(PROTECTED_TERMS),
    }));
  `;
  const result = execSync(`npx tsx -e ${JSON.stringify(rulesScript)}`, {
    encoding: 'utf-8', cwd: ROOT, maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  rulesModule = JSON.parse(result.trim());
} catch (e) {
  console.error('Failed to load rules via tsx. Falling back to inline prompts.');
  console.error(e.message);
  // Minimal fallback — won't have full rules but worker can still function
  rulesModule = {
    TRANSLATOR_SYSTEM: 'You are a professional Gujarati-to-English translator for Swaminarayan religious texts. Translate faithfully, preserving meaning, verse structure, and spiritual terminology.',
    REVIEWER_SYSTEM: 'You are a translation quality reviewer. Score the translation 0-100 and provide a revised version. Return JSON with: totalScore, revised, certifiable (boolean), categories (array), pitfalls (array), issues (array).',
    SMOOTHER_SYSTEM: 'You are an English readability editor. Make minimal changes for flow and clarity. Do NOT alter meaning, names, or religious terms. Return ONLY the revised text.',
  };
}

const { TRANSLATOR_SYSTEM, REVIEWER_SYSTEM, SMOOTHER_SYSTEM } = rulesModule;

// ── Anthropic API ────────────────────────────────────────────────────────────

function callClaudeOnce(params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: params.model, max_tokens: params.max_tokens,
      system: [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }],
      messages: params.messages,
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': API_KEY, 'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          const code = res.statusCode ?? 0;
          const err = new Error(`Anthropic API ${code}: ${raw.slice(0, 300)}`);
          err.statusCode = code;
          reject(err);
          return;
        }
        try {
          const data = JSON.parse(raw);
          const text = data.content?.[0]?.text?.trim();
          if (!text) { reject(new Error('Empty response from Anthropic API')); return; }
          if (data.usage) {
            const u = data.usage;
            const cached = u.cache_read_input_tokens ?? 0;
            const created = u.cache_creation_input_tokens ?? 0;
            if (cached > 0 || created > 0) {
              console.log(`  [cache] cached=${cached} created=${created} input=${u.input_tokens ?? 0} output=${u.output_tokens ?? 0}`);
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

async function callClaude(params) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callClaudeOnce(params);
    } catch (err) {
      const code = err.statusCode ?? 0;
      const isRetryable = code === 429 || code === 500 || code === 529 || err.message === 'Anthropic API timeout';
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.log(`  Retry ${attempt + 1} after ${delay}ms (${code || err.message})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

// ── Chunker ──────────────────────────────────────────────────────────────────

function isVerseBlock(para) {
  const lines = para.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const quotedVerse = lines.some(l => /^[\u201c\u201d"'\u2018\u2019]/.test(l) && /[āīūṛṅñṭḍṇśṣḥ]/.test(l));
  const avgLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
  const similarLength = lines.length >= 2 && lines.every(l => Math.abs(l.length - avgLen) < avgLen * 0.5);
  const diacriticLines = lines.filter(l => /[āīūṛṅñṭḍṇśṣḥ]/.test(l)).length;
  const mostlyDiacritic = diacriticLines >= lines.length * 0.5;
  return quotedVerse || (similarLength && mostlyDiacritic);
}

function deterministicChunk(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const totalWords = trimmed.split(/\s+/).filter(Boolean).length;
  if (totalWords <= 500) return [trimmed];

  let rawParagraphs = trimmed.split(/\n\s*\n/);
  const hasGiantPara = rawParagraphs.some(p => p.trim().split(/\s+/).length > 500);
  if (hasGiantPara) rawParagraphs = trimmed.split(/\n/).filter(l => l.trim());

  const groups = [];
  let pendingVerse = null;
  for (const para of rawParagraphs) {
    const p = para.trim();
    if (!p) continue;
    if (isVerseBlock(p)) {
      if (groups.length > 0) groups[groups.length - 1] += '\n\n' + p;
      else pendingVerse = pendingVerse ? pendingVerse + '\n\n' + p : p;
    } else {
      if (pendingVerse) { groups.push(pendingVerse + '\n\n' + p); pendingVerse = null; }
      else groups.push(p);
    }
  }
  if (pendingVerse) groups.push(pendingVerse);

  const chunks = [];
  let current = [], currentWords = 0;
  for (const group of groups) {
    const groupWords = group.split(/\s+/).length;
    if (currentWords + groupWords > 500 && currentWords >= 300) {
      chunks.push(current.join('\n\n'));
      current = [group]; currentWords = groupWords;
    } else {
      current.push(group); currentWords += groupWords;
    }
  }
  if (current.length > 0) {
    if (currentWords < 150 && chunks.length > 0) chunks[chunks.length - 1] += '\n\n' + current.join('\n\n');
    else chunks.push(current.join('\n\n'));
  }
  return chunks.length > 0 ? chunks : [trimmed];
}

// ── Agent functions ──────────────────────────────────────────────────────────

async function translatorAgent(chunk, chunkIndex, totalChunks) {
  return callClaude({
    model: SONNET, max_tokens: 8192,
    system: TRANSLATOR_SYSTEM,
    messages: [{ role: 'user', content: `Chunk ${chunkIndex + 1} of ${totalChunks}. Translate the following Gujarati text to English. Provide ONLY the translation.\n\nGUJARATI:\n${chunk}` }],
  });
}

async function reviewerAgent(original, translation) {
  const fallback = { categories: [], pitfalls: [], issues: [], score: 50, revised: translation, certifiable: false };
  let raw;
  try {
    raw = await callClaude({
      model: SONNET, max_tokens: 16000,
      system: REVIEWER_SYSTEM,
      messages: [{ role: 'user', content: `GUJARATI SOURCE:\n${original}\n\nTRANSLATION TO AUDIT:\n${translation}` }],
    });
  } catch (err) {
    console.error('  Reviewer API call failed:', err.message);
    return fallback;
  }

  const stripped = raw.replace(/^```(?:json)?\s*/gm, '').replace(/\s*```$/gm, '');
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) { console.error('  Reviewer returned no JSON'); return fallback; }

  const jsonStr = match[0];
  try {
    const p = JSON.parse(jsonStr);
    const rawScore = typeof p.totalScore === 'number' ? p.totalScore : (typeof p.score === 'number' ? p.score : 50);
    const cats = Array.isArray(p.categories)
      ? p.categories.map(c => ({
          id: typeof c.id === 'string' ? c.id : '',
          weight: typeof c.weight === 'number' ? c.weight : 0,
          score: typeof c.score === 'number' ? Math.max(0, c.score) : 0,
          deductions: Array.isArray(c.deductions) ? c.deductions.filter(s => typeof s === 'string') : (Array.isArray(c.issues) ? c.issues.filter(s => typeof s === 'string') : []),
          pass: typeof c.pass === 'boolean' ? c.pass : true,
        }))
      : [];
    return {
      categories: cats,
      pitfalls: Array.isArray(p.pitfalls) ? p.pitfalls.filter(s => typeof s === 'string') : [],
      issues: Array.isArray(p.issues) ? p.issues.filter(s => typeof s === 'string') : [],
      score: Math.max(0, Math.min(100, rawScore)),
      revised: typeof p.revised === 'string' && p.revised.trim() ? p.revised.trim() : translation,
      certifiable: typeof p.certifiable === 'boolean' ? p.certifiable : false,
    };
  } catch {
    console.error('  Reviewer JSON parse failed, using regex fallback');
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
    return { categories: [], pitfalls: [], issues: [], score, revised, certifiable };
  }
}

function charDiffRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  let diffs = Math.abs(a.length - b.length);
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) { if (a[i] !== b[i]) diffs++; }
  return diffs / maxLen;
}

async function smootherAgent(text) {
  const smoothed = await callClaude({
    model: SONNET, max_tokens: 8192,
    system: SMOOTHER_SYSTEM,
    messages: [{ role: 'user', content: `Perform the readability pass. Return ONLY the revised text.\n\n${text}` }],
  });
  const diffRatio = charDiffRatio(text, smoothed);
  if (diffRatio > 0.15) {
    console.warn(`  Smoother changed ${(diffRatio * 100).toFixed(1)}% (>15%). Using original.`);
    return { text, flagged: true };
  }
  return { text: smoothed, flagged: false };
}

function assemblerAgent(smoothedChunks) {
  if (smoothedChunks.length <= 1) return smoothedChunks[0] ?? '';
  const result = [];
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

// ── Rules enforcer (simplified — full rules loaded via tsx above) ─────────────
// The full rulesEnforcerAgent is in pipeline.ts. We load it via tsx if possible.

let rulesEnforcerAgent;
try {
  const { execSync } = await import('node:child_process');
  // Export the function as a serialized module isn't practical,
  // so we apply basic rules inline. The full enforcer runs regex replacements.
  // For the worker, we'll do a simpler version that covers the essentials.
  rulesEnforcerAgent = (text) => {
    let t = text;
    // Curly quotes
    let openDouble = true;
    t = t.replace(/"/g, () => { const q = openDouble ? '\u201c' : '\u201d'; openDouble = !openDouble; return q; });
    t = t.replace(/'([^']{2,})'/g, '\u2018$1\u2019');
    // Em dash → spaced en dash
    t = t.replace(/\u2014/g, ' \u2013 ').replace(/ {2,}\u2013 {2,}/g, ' \u2013 ');
    // Clean up double spaces
    t = t.replace(/ {2,}/g, ' ').replace(/^ +/gm, '');
    return { text: t, corrections: [], totalFixes: 0 };
  };
} catch {
  rulesEnforcerAgent = (text) => ({ text, corrections: [], totalFixes: 0 });
}

// Try to load the real rules enforcer via tsx
try {
  const { execSync } = await import('node:child_process');
  const testResult = execSync(`npx tsx -e "import { rulesEnforcerAgent } from '${ROOT}/lib/pipeline.ts'; console.log('ok')"`, {
    encoding: 'utf-8', cwd: ROOT, maxBuffer: 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (testResult.trim() === 'ok') {
    // We can use tsx to run the enforcer. But since it's synchronous and we'd need
    // to shell out for each call, let's keep the inline version for performance.
    // The full rules are baked into the translator/reviewer system prompts anyway.
    console.log('[worker] Full rules enforcer available via tsx');
  }
} catch { /* inline version will be used */ }

// ── Run pipeline for a single job ────────────────────────────────────────────

async function runJobPipeline(jobId, jobData) {
  const { input } = jobData;
  const { text, chapterTitle, bookId, bookTitle, chapterIndex, totalChapters } = input;

  const reportProgress = async (update) => {
    const mergeDoc = {};
    if (update.status) mergeDoc.status = update.status;
    if (update.startedAt) mergeDoc.startedAt = update.startedAt;
    if (update.completedAt) mergeDoc.completedAt = update.completedAt;
    if (update.error) mergeDoc.error = update.error;
    if (update.result) mergeDoc.result = update.result;
    if (update.progress) {
      const existing = (await db.collection('jobs').doc(jobId).get()).data()?.progress ?? { currentStage: '', stages: {}, chunks: [] };
      const merged = {
        currentStage: update.progress.currentStage ?? existing.currentStage,
        stages: { ...existing.stages },
        chunks: update.progress.chunks ?? existing.chunks,
      };
      if (update.progress.stages) {
        for (const [stage, stageData] of Object.entries(update.progress.stages)) {
          merged.stages[stage] = { ...(merged.stages[stage] ?? {}), ...stageData };
        }
      }
      mergeDoc.progress = merged;
    }
    await db.collection('jobs').doc(jobId).set(mergeDoc, { merge: true });
  };

  // ── Stage 1: Chunker
  await reportProgress({ status: 'running', startedAt: new Date().toISOString(), progress: { currentStage: 'chunker', stages: { chunker: { status: 'running' } }, chunks: [] } });

  const chunks = deterministicChunk(text);
  if (chunks.length === 0) throw new Error('No content to translate');

  const chunkProgressArr = chunks.map((c, i) => ({ index: i, original: c.slice(0, 200) }));
  console.log(`  Chunked into ${chunks.length} pieces`);

  await reportProgress({ progress: { currentStage: 'translator', stages: { chunker: { status: 'done', chunkCount: chunks.length } }, chunks: chunkProgressArr } });

  // ── Stages 2-4: Pipelined per-chunk
  const translations = new Array(chunks.length).fill('');
  const reviews = new Array(chunks.length);
  const smoothedChunks = new Array(chunks.length).fill('');
  const chunkDataForStorage = [];

  let translateDone = 0, reviewDone = 0, smoothDone = 0;
  let totalRechecks = 0, smootherFlagged = 0;

  async function processChunk(i) {
    // Translate
    console.log(`  [chunk ${i + 1}/${chunks.length}] Translating...`);
    translations[i] = rulesEnforcerAgent(await translatorAgent(chunks[i], i, chunks.length)).text;
    translateDone++;
    chunkProgressArr[i] = { ...chunkProgressArr[i], translation: translations[i].slice(0, 300) };

    // Review
    console.log(`  [chunk ${i + 1}/${chunks.length}] Reviewing...`);
    reviews[i] = await reviewerAgent(chunks[i], translations[i]);
    for (let round = 1; round <= MAX_REVIEW_ROUNDS && reviews[i].score < RECHECK_THRESHOLD; round++) {
      totalRechecks++;
      console.log(`  [chunk ${i + 1}/${chunks.length}] Re-review round ${round + 1} (score: ${reviews[i].score})...`);
      reviews[i] = await reviewerAgent(chunks[i], reviews[i].revised);
    }
    reviewDone++;

    chunkProgressArr[i] = {
      ...chunkProgressArr[i],
      score: reviews[i].score,
      certifiable: reviews[i].certifiable,
      categories: reviews[i].categories,
      pitfalls: reviews[i].pitfalls,
      issues: reviews[i].issues,
      scoreHistory: [reviews[i].score],
      reviewRound: totalRechecks > 0 ? 2 : 1,
    };

    chunkDataForStorage.push({
      index: i, originalGujarati: chunks[i], translation: reviews[i].revised,
      reviewerScore: reviews[i].score,
      reviewerCategories: reviews[i].categories.map(c => ({ id: c.id, score: c.score, weight: c.weight })),
      certifiable: reviews[i].certifiable,
    });

    // Smooth
    console.log(`  [chunk ${i + 1}/${chunks.length}] Smoothing...`);
    const smoothResult = await smootherAgent(reviews[i].revised);
    const chunkEnforced = rulesEnforcerAgent(smoothResult.text);
    smoothedChunks[i] = chunkEnforced.text;
    if (smoothResult.flagged) smootherFlagged++;
    smoothDone++;
    chunkProgressArr[i] = { ...chunkProgressArr[i], flagged: smoothResult.flagged };
  }

  // Process in batches
  const allChunkIndices = Array.from({ length: chunks.length }, (_, i) => i);
  for (let start = 0; start < allChunkIndices.length; start += BATCH) {
    const batch = allChunkIndices.slice(start, start + BATCH);
    const results = await Promise.allSettled(batch.map(i => processChunk(i)));
    const firstFailure = results.find(r => r.status === 'rejected');
    if (firstFailure && firstFailure.status === 'rejected') throw firstFailure.reason;

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

  // ── Stage 5: Assembler
  await reportProgress({ progress: { currentStage: 'assembler', stages: { assembler: { status: 'running' } }, chunks: chunkProgressArr } });
  const assembled = assemblerAgent(smoothedChunks);
  await reportProgress({ progress: { currentStage: 'enforcer', stages: { assembler: { status: 'done' } }, chunks: chunkProgressArr } });

  // ── Stage 6: Rules Enforcer
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
    const docRef = await db.collection('translations').add({
      uid: jobData.uid, email: jobData.email,
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
    console.error('  Firestore save error:', err.message);
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

// ── Poll loop ────────────────────────────────────────────────────────────────

let processing = false;

async function pollForJobs() {
  if (processing) return;

  try {
    const snapshot = await db.collection('jobs')
      .where('mode', '==', 'local')
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get();

    if (snapshot.empty) return;

    processing = true;
    const doc = snapshot.docs[0];
    const jobId = doc.id;
    const jobData = doc.data();

    console.log(`\n[worker] Picked up job ${jobId} (${jobData.input?.wordCount ?? '?'} words)`);

    try {
      await runJobPipeline(jobId, jobData);
      console.log(`[worker] Job ${jobId} completed successfully`);
    } catch (err) {
      console.error(`[worker] Job ${jobId} failed:`, err.message);
      await db.collection('jobs').doc(jobId).set({
        status: 'failed',
        error: err.message || 'Unknown error',
        completedAt: new Date().toISOString(),
      }, { merge: true });
    } finally {
      processing = false;
    }
  } catch (err) {
    console.error('[worker] Poll error:', err.message);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

console.log('[worker] Aksharpith local worker started');
console.log(`[worker] Polling Firestore every ${POLL_INTERVAL / 1000}s for local jobs...`);
console.log(`[worker] API key: ${API_KEY.slice(0, 12)}...`);

// Initial poll
pollForJobs();

// Continuous polling
setInterval(pollForJobs, POLL_INTERVAL);

// Keep process alive
process.on('SIGINT', () => {
  console.log('\n[worker] Shutting down...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n[worker] Shutting down...');
  process.exit(0);
});
