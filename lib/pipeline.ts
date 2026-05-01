import https from 'node:https';
import {
  TERMINOLOGY_RULES,
  PERSONAL_NAME_RULES,
  PLACE_NAME_RULES,
  FORBIDDEN_VOCAB_RULES,
  HEDGING_RULES,
  DATE_FORMAT_RULES,
  DIACRITICS_MAP,
  buildTranslatorSystem,
  buildSmootherSystem,
} from './rules';
import type { RulesCorrection } from './rules';
import type { PipelineInput, PipelineAuth, ProgressReporter, ChunkProgress } from './job-types';
import { parseTranslator, parseSmoother, ParserError } from './parser';

// ─── Config ──────────────────────────────────────────────────────────────────

const SONNET = 'claude-sonnet-4-20250514';
const BATCH  = 5;
const API_TIMEOUT_MS    = 90_000;
const MAX_RETRIES       = 1;

// ─── Build prompts once ──────────────────────────────────────────────────────

const TRANSLATOR_SYSTEM = buildTranslatorSystem();
const SMOOTHER_SYSTEM   = buildSmootherSystem();

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

// ─── Deterministic chunker ──────────────────────────────────────────────────

function isVerseBlock(para: string): boolean {
  const lines = para.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const quotedVerse = lines.some(l => /^[“”"'‘’]/.test(l) && /[āīūṛṅñṭḍṇśṣḥ]/.test(l));
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

/**
 * Translator agent — sadhu-approved Prompts 1+2+3. Returns an English
 * translation plus translator self-flags for any low-confidence span.
 * XML output, strict parser. Throws ParserError on malformed XML.
 */
async function translatorAgent(
  apiKey: string, chunk: string, chunkIndex: number, totalChunks: number,
): Promise<{ translation: string; flags: string[] }> {
  const raw = await callClaude({
    model: SONNET, max_tokens: 8192, apiKey,
    system: TRANSLATOR_SYSTEM,
    messages: [{ role: 'user', content: `Chunk ${chunkIndex + 1} of ${totalChunks}. Translate the following Gujarati text into English following the rules above. For verse or poetic lines, include the Roman transliteration in curly quotes first, then the English meaning in parentheses — both mandatory. Output ONLY the two XML blocks specified in the system prompt: <translation>…</translation><flags>…</flags>.\n\nGUJARATI:\n${chunk}` }],
  });
  return parseTranslator(raw);
}

/**
 * Smoother agent — Prompt 4 verbatim. Strict <smoothed> XML output. The
 * "What to never change" list inside the prompt is the safeguard. If the
 * model returns malformed XML, ParserError is thrown and the chunk falls
 * back to the unsmoothed translator output (handled by the caller).
 */
async function smootherAgent(apiKey: string, text: string): Promise<{ smoothed: string }> {
  const raw = await callClaude({
    model: SONNET, max_tokens: 8192, apiKey,
    system: SMOOTHER_SYSTEM,
    messages: [{ role: 'user', content: `Smooth the following passage per the rules above. Output ONLY <smoothed>…</smoothed>.\n\n${text}` }],
  });
  return parseSmoother(raw);
}

// ─── Macron preservation guard ──────────────────────────────────────────────
//
// The smoother is an LLM and may "consistency-clean" verse transliterations
// like "Ātmā jāgo re" into the prose form "Atma jago re", which is data
// loss. The translator emits ā characters per the prompt; the smoother is
// instructed to preserve them but cannot be trusted unilaterally.
//
// preserveMacrons() is a deterministic safety net:
// 1. For each line in the translator output containing "ā", check whether
//    the smoother dropped or stripped it.
// 2. If a translator verse-line has an obvious macron-stripped twin in the
//    smoother output, replace the twin with the original.
// 3. Returns the patched smoother text plus a count of restorations.

export function preserveMacrons(translatorText: string, smootherText: string): { text: string; restored: number } {
  // Match both lowercase ā (U+0101) and uppercase Ā (U+0100).
  const MACRON = /[Āā]/g;
  const stripMacron = (s: string) => s.replace(/Ā/g, 'A').replace(/ā/g, 'a');

  const translatorMacronCount = (translatorText.match(MACRON) ?? []).length;
  const smootherMacronCount = (smootherText.match(MACRON) ?? []).length;
  if (translatorMacronCount === 0) return { text: smootherText, restored: 0 };
  if (smootherMacronCount >= translatorMacronCount) return { text: smootherText, restored: 0 };

  // Build the candidate set: translator lines containing a macron. These are
  // the verse transliterations we must protect.
  const translatorLines = translatorText.split('\n');
  const verseLines = translatorLines.filter(l => /[Āā]/.test(l));

  let patched = smootherText;
  let restored = 0;
  for (const verseLine of verseLines) {
    if (patched.includes(verseLine)) continue;        // already preserved verbatim
    const stripped = stripMacron(verseLine);
    if (patched.includes(stripped)) {
      // Smoother stripped the macrons on this exact line — restore it.
      patched = patched.replace(stripped, verseLine);
      restored += (verseLine.match(MACRON) ?? []).length;
    }
  }
  return { text: patched, restored };
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
  t = t.replace(/"/g, () => { const q = openDouble ? '“' : '”'; openDouble = !openDouble; return q; });
  if (t !== bq) corrections.push({ from: '"', to: '“/”', rule: 'straight quotes→curly quotes', count: (bq.match(/"/g) || []).length });
  const bs = t;
  t = t.replace(/'([^']{2,})'/g, '‘$1’');
  if (t !== bs) corrections.push({ from: "'x'", to: '‘x’', rule: 'straight single quotes→curly', count: 1 });

  const bd = t;
  t = t.replace(/—/g, ' – ');
  t = t.replace(/ {2,}– {2,}/g, ' – ');
  if (t !== bd) corrections.push({ from: '—', to: ' – ', rule: 'em dash→spaced en dash', count: (bd.match(/—/g) || []).length });

  for (const [from, to] of Object.entries(DIACRITICS_MAP)) {
    const before = t;
    t = t.split(from).join(to);
    if (t !== before) corrections.push({ from, to, rule: 'forbidden diacritics stripped (only ā permitted)', count: before.split(from).length - 1 });
  }

  return { text: t, corrections, totalFixes: corrections.reduce((s, c) => s + c.count, 0) };
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────
//
// Sadhu-approved chain:
//   chunker → translator → enforcer → smoother → enforcer → assembler → enforcer
//
// Two LLM calls per chunk. Three deterministic enforcer passes. No reviewer.
// No quality scoring. Validation is human side-by-side judgement, not a
// model-generated number.

export async function runPipeline(
  input: PipelineInput,
  auth: PipelineAuth,
  reportProgress: ProgressReporter,
  adminDb: FirebaseFirestore.Firestore,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const { text, chapterTitle, bookId, bookTitle, chapterIndex, totalChapters } = input;

  const chunkProgressArr: ChunkProgress[] = [];

  // ── Stage 1: Chunker ──────────────────────────────────────────────────
  await reportProgress({ status: 'running', startedAt: new Date().toISOString(), progress: { currentStage: 'chunker', stages: { chunker: { status: 'running' } }, chunks: [] } });

  const chunks = deterministicChunk(text);
  if (chunks.length === 0) throw new Error('No content to translate');

  for (let i = 0; i < chunks.length; i++) {
    chunkProgressArr.push({ index: i, original: chunks[i].slice(0, 200) });
  }

  await reportProgress({ progress: { currentStage: 'translator', stages: { chunker: { status: 'done', chunkCount: chunks.length } }, chunks: chunkProgressArr } });

  // ── Stages 2-3: Pipelined per-chunk (translator → enforcer → smoother → enforcer) ─
  const translations: string[] = new Array(chunks.length).fill('');
  const chunkFlags: string[][] = Array.from({ length: chunks.length }, () => []);
  const smoothedChunks: string[] = new Array(chunks.length).fill('');

  const chunkDataForStorage: Array<{
    index: number; originalGujarati: string; translation: string; flags: string[];
  }> = [];

  let translateDone = 0, smoothDone = 0;

  function stageSnapshot() {
    return {
      chunker: { status: 'done' as const, chunkCount: chunks.length },
      translator: { status: (translateDone >= chunks.length ? 'done' : 'running') as 'done' | 'running', completed: translateDone, total: chunks.length },
      smoother: { status: (smoothDone >= chunks.length ? 'done' : (smoothDone > 0 || translateDone > 0 ? 'running' : 'waiting')) as 'done' | 'running' | 'waiting', completed: smoothDone, total: chunks.length },
    };
  }

  async function processChunk(i: number) {
    const chunkLabel = chunks.length === 1 ? '' : ` chunk ${i + 1}/${chunks.length}`;
    const srcWords = chunks[i].split(/\s+/).length;

    // Translate (XML output: <translation> + <flags>)
    await reportProgress({ progress: { currentStage: 'translator', commentary: `Translating${chunkLabel} (${srcWords} words) with full Aksharpith style context…`, stages: stageSnapshot(), chunks: chunkProgressArr } });
    const translatorOut = await translatorAgent(apiKey!, chunks[i], i, chunks.length);
    // Enforce rules on translator output before passing to smoother — the
    // smoother sees rules-clean input so it cannot reintroduce banned terms.
    translations[i] = rulesEnforcerAgent(translatorOut.translation).text;
    chunkFlags[i] = translatorOut.flags;
    translateDone++;
    chunkProgressArr[i] = {
      ...chunkProgressArr[i],
      translation: translations[i].slice(0, 300),
      flags: translatorOut.flags,
    };
    const flagSummary = translatorOut.flags.length === 0
      ? 'no self-flags'
      : `${translatorOut.flags.length} self-flag${translatorOut.flags.length === 1 ? '' : 's'}`;
    await reportProgress({ progress: { currentStage: 'translator', commentary: `Translated${chunkLabel} — ${translations[i].split(/\s+/).length} words output, ${flagSummary}`, stages: stageSnapshot(), chunks: chunkProgressArr } });

    // Smoother (XML output: <smoothed>). On parser/model failure, fall back
    // to the unsmoothed translator output rather than corrupting the chunk.
    await reportProgress({ progress: { currentStage: 'smoother', commentary: `Smoothing${chunkLabel} — preserving direct quotes, transliterated verses and proper nouns…`, stages: stageSnapshot(), chunks: chunkProgressArr } });
    let smoothedText = translations[i];
    let smootherFallback = false;
    try {
      const smoothed = await smootherAgent(apiKey!, translations[i]);
      smoothedText = smoothed.smoothed;
    } catch (err) {
      smootherFallback = true;
      const message = err instanceof ParserError ? err.message : (err instanceof Error ? err.message : 'unknown');
      console.warn(`[pipeline] Smoother fallback on chunk ${i}: ${message}`);
    }

    // Defensive: restore any macrons the smoother stripped on verse lines.
    const { text: macronSafe, restored: macronsRestored } = preserveMacrons(translations[i], smoothedText);
    smoothedText = macronSafe;
    if (macronsRestored > 0) {
      const flag = `Smoother stripped ${macronsRestored} macron${macronsRestored === 1 ? '' : 's'} from verse transliteration${macronsRestored === 1 ? '' : 's'} — auto-restored from translator output.`;
      chunkFlags[i] = [...chunkFlags[i], flag];
      console.warn(`[pipeline] chunk ${i}: ${flag}`);
    }

    smoothedChunks[i] = rulesEnforcerAgent(smoothedText).text;
    smoothDone++;
    chunkProgressArr[i] = {
      ...chunkProgressArr[i],
      flags: chunkFlags[i],
    };
    await reportProgress({ progress: { currentStage: 'smoother', commentary: `Smoothed${chunkLabel}${smootherFallback ? ' (fell back to translator output)' : ''}${macronsRestored > 0 ? ` — restored ${macronsRestored} macron${macronsRestored === 1 ? '' : 's'}` : ''}`, stages: stageSnapshot(), chunks: chunkProgressArr } });

    chunkDataForStorage.push({
      index: i,
      originalGujarati: chunks[i],
      translation: smoothedChunks[i],
      flags: chunkFlags[i],
    });
  }

  // Process in batches — report progress after each batch
  const allChunkIndices = Array.from({ length: chunks.length }, (_, i) => i);
  for (let start = 0; start < allChunkIndices.length; start += BATCH) {
    const batch = allChunkIndices.slice(start, start + BATCH);
    const results = await Promise.allSettled(batch.map(i => processChunk(i)));
    const firstFailure = results.find(r => r.status === 'rejected');
    if (firstFailure && firstFailure.status === 'rejected') throw firstFailure.reason;

    const currentStage = smoothDone === chunks.length
      ? 'assembler'
      : translateDone > 0 ? 'smoother' : 'translator';
    await reportProgress({
      progress: {
        currentStage,
        stages: stageSnapshot(),
        chunks: chunkProgressArr,
      },
    });
  }

  // ── Stage 4: Assembler (deterministic) ────────────────────────────────
  await reportProgress({ progress: { currentStage: 'assembler', commentary: `Joining ${chunks.length} chunks into a single document — deduplicating boundary overlaps…`, stages: { assembler: { status: 'running' } }, chunks: chunkProgressArr } });
  const assembled = assemblerAgent(smoothedChunks);
  await reportProgress({ progress: { currentStage: 'enforcer', commentary: 'Document assembled successfully', stages: { assembler: { status: 'done' } }, chunks: chunkProgressArr } });

  // ── Stage 5: Rules Enforcer (deterministic) ───────────────────────────
  await reportProgress({ progress: { currentStage: 'enforcer', commentary: 'Running deterministic rules — terminology, punctuation, diacritics, place names…', stages: { enforcer: { status: 'running' } }, chunks: chunkProgressArr } });
  const enforced = rulesEnforcerAgent(assembled);
  const finalText = enforced.text;
  const finalWords = finalText.trim().split(/\s+/).filter(Boolean).length;
  const totalFlags = chunkFlags.reduce((s, f) => s + f.length, 0);

  // Persist translation. Two LLM calls, three enforcer passes, no scoring.
  let translationId = '';
  try {
    const docRef = await adminDb.collection('translations').add({
      uid: auth.uid, email: auth.email,
      chapterTitle: chapterTitle || null, bookId: bookId || null, bookTitle: bookTitle || null,
      chapterIndex: chapterIndex ?? null, totalChapters: totalChapters ?? null,
      inputWordCount: input.wordCount, outputWordCount: finalWords,
      output: finalText,
      inputPreview: text.slice(0, 300),
      chunkData: chunkDataForStorage.sort((a, b) => a.index - b.index),
      flagsCount: totalFlags,
      createdAt: new Date().toISOString(),
    });
    translationId = docRef.id;
  } catch (err) {
    console.error('Firestore save error:', err);
  }

  // Report completion.
  await reportProgress({
    status: 'completed',
    completedAt: new Date().toISOString(),
    progress: {
      currentStage: 'enforcer',
      stages: { enforcer: { status: 'done', totalFixes: enforced.totalFixes } },
      chunks: chunkProgressArr,
    },
    result: {
      output: finalText,
      wordCount: finalWords,
      totalFixes: enforced.totalFixes,
      corrections: enforced.corrections.map(c => ({ from: c.from, to: c.to, rule: c.rule, count: c.count })),
      flagsCount: totalFlags,
      translationId,
    },
  });
}
