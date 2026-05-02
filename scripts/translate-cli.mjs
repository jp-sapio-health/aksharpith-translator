#!/usr/bin/env node
/**
 * Aksharpith local CLI — direct Gujarati → English + transliteration pipeline.
 *
 * Bypasses the Vercel/Firestore round-trip entirely. Reads a Gujarati file,
 * runs the translator + smoother + transliterator stages locally via the
 * Claude Agent SDK (Claude Max plan), and writes four output files alongside
 * the source: <name>-english.txt, <name>-english.docx, <name>-translit.txt,
 * <name>-translit.docx.
 *
 * Usage:
 *   node scripts/translate-cli.mjs <file.txt|.docx|.pdf>
 *   node scripts/translate-cli.mjs <file> --no-smoother    # skip smoother stage
 *   node scripts/translate-cli.mjs <file> --english-only   # skip transliteration
 *   node scripts/translate-cli.mjs <file> --translit-only  # skip translation
 *
 * Env: requires CLAUDE_CODE_OAUTH_TOKEN in .env.local (`claude setup-token`).
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, extname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith('--'));
const noSmoother = args.includes('--no-smoother');
const englishOnly = args.includes('--english-only');
const translitOnly = args.includes('--translit-only');

if (!filePath) {
  console.log('Usage: node scripts/translate-cli.mjs <file.txt|.docx|.pdf> [--no-smoother] [--english-only] [--translit-only]');
  process.exit(1);
}

const absPath = resolve(filePath);
if (!existsSync(absPath)) { console.error(`File not found: ${absPath}`); process.exit(1); }

// ── Env ─────────────────────────────────────────────────────────────────────

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
if (env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
}
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error('Missing CLAUDE_CODE_OAUTH_TOKEN. Run `claude setup-token` and add to .env.local.');
  process.exit(1);
}

// ── Load prompts via tsx ────────────────────────────────────────────────────

const { execSync } = await import('node:child_process');
const promptScript = `import { buildTranslatorSystem, buildSmootherSystem } from '${ROOT}/lib/rules/index.ts'; import { buildTransliteratorSystem } from '${ROOT}/lib/rules/transliterator-prompt.ts'; console.log(JSON.stringify({ TRANSLATOR_SYSTEM: buildTranslatorSystem(), SMOOTHER_SYSTEM: buildSmootherSystem(), TRANSLITERATOR_SYSTEM: buildTransliteratorSystem() }));`;
const prompts = JSON.parse(execSync(`npx tsx -e ${JSON.stringify(promptScript)}`, {
  encoding: 'utf-8', cwd: ROOT, maxBuffer: 5 * 1024 * 1024, env: { ...process.env, ...env },
}).trim());
const { TRANSLATOR_SYSTEM, SMOOTHER_SYSTEM, TRANSLITERATOR_SYSTEM } = prompts;

// ── Claude Agent SDK ────────────────────────────────────────────────────────

import { query } from '@anthropic-ai/claude-agent-sdk';
const SDK_CWD = mkdtempSync(`${tmpdir()}/aksharpith-sdk-`);
const SONNET = 'claude-sonnet-4-20250514';
const SDK_MAX_RETRIES = 2;
const SDK_RETRY_DELAY_MS = 5_000;

async function callClaudeOnce({ system, userPrompt, contentBlocks }) {
  // Build the prompt: simple string for text-only, or AsyncIterable<SDKUserMessage>
  // when we need to send a content array (e.g. PDF document block for vision OCR).
  let prompt;
  if (contentBlocks) {
    const userMessage = {
      type: 'user',
      message: { role: 'user', content: contentBlocks },
      parent_tool_use_id: null,
      session_id: '',
    };
    prompt = (async function* () { yield userMessage; })();
  } else {
    prompt = userPrompt;
  }

  const q = query({
    prompt,
    options: {
      systemPrompt: system,
      model: SONNET,
      tools: [],
      maxTurns: 1,
      cwd: SDK_CWD,
      permissionMode: 'bypassPermissions',
    },
  });
  let text = '';
  let errorKind = null;
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      if (msg.error) errorKind = msg.error;
      for (const block of msg.message.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      }
    } else if (msg.type === 'result' && msg.subtype !== 'success') {
      errorKind = errorKind ?? msg.subtype;
    }
  }
  if (errorKind) throw new Error(`Claude SDK error: ${errorKind}`);
  if (!text.trim()) throw new Error('Empty response from Claude SDK');
  return text;
}

async function callClaude(opts) {
  let lastErr;
  for (let attempt = 0; attempt <= SDK_MAX_RETRIES; attempt++) {
    try { return await callClaudeOnce(opts); }
    catch (err) {
      lastErr = err;
      console.error(`  retry ${attempt + 1}/${SDK_MAX_RETRIES + 1}: ${err.message}`);
      if (attempt < SDK_MAX_RETRIES) await new Promise(r => setTimeout(r, SDK_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ── PDF vision OCR (for image-only PDFs) ────────────────────────────────────

const PDF_OCR_PROMPT = `Extract ALL text from this PDF document exactly as written. Preserve:
- Every paragraph (blank line between paragraphs)
- All Gujarati Unicode text exactly as it appears
- All numbers, dates, names, verses
- Chapter/section headings (mark as "=== CHAPTER: <title> ===" on its own line)
- Verse/kirtan lines on separate lines
- Table content with structure

Return ONLY the extracted text — no commentary, no notes, no preamble.`;

const PAGES_PER_OCR_CHUNK = 30;

async function splitPdfIntoChunks(buf, pagesPerChunk) {
  const { PDFDocument } = await import('pdf-lib');
  const srcDoc = await PDFDocument.load(buf);
  const totalPages = srcDoc.getPageCount();
  const chunks = [];
  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages);
    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(srcDoc, Array.from({ length: end - start }, (_, i) => start + i));
    for (const page of pages) newDoc.addPage(page);
    chunks.push({ buf: Buffer.from(await newDoc.save()), startPage: start, endPage: end });
  }
  return { chunks, totalPages };
}

async function ocrPdfBuffer(pdfBuf) {
  const base64 = pdfBuf.toString('base64');
  return await callClaude({
    system: 'You are an OCR engine. Extract text from PDF documents preserving all original formatting, language scripts (especially Gujarati), and structural markers.',
    contentBlocks: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: PDF_OCR_PROMPT },
    ],
  });
}

const IMAGE_OCR_PROMPT = `Extract ALL text from this image exactly as written. This may be a scan or photograph of a page containing Gujarati and/or English text. Preserve:
- All Gujarati Unicode text exactly as it appears
- All English text exactly
- All numbers, dates, names
- Paragraph breaks and structure
- Any headings, bullet points, or numbered lists

Return ONLY the extracted text — no commentary, no notes, no preamble.`;

const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

async function ocrImageBuffer(imgBuf, mediaType) {
  const base64 = imgBuf.toString('base64');
  return await callClaude({
    system: 'You are an OCR engine. Extract text from images preserving all original formatting and language scripts (especially Gujarati).',
    contentBlocks: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: IMAGE_OCR_PROMPT },
    ],
  });
}

// ── Extract text from input ─────────────────────────────────────────────────

const ext = extname(absPath).toLowerCase();
let text = '';

if (ext === '.txt') {
  text = readFileSync(absPath, 'utf-8');
} else if (ext === '.docx') {
  const mammoth = await import('mammoth');
  const buf = readFileSync(absPath);
  text = (await mammoth.default.convertToHtml({ buffer: buf })).value
    .replace(/<\/p>/g, '\n\n').replace(/<br\/>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
} else if (ext === '.pdf') {
  const buf = readFileSync(absPath);

  // Step 1: try pdf-parse (fast, free, works for text-PDFs).
  try {
    const { default: pdfParse } = await import('pdf-parse');
    const parsed = await pdfParse(buf);
    const localText = parsed.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const indic = (localText.match(/[઀-૿ऀ-ॿ]/g) ?? []).length;
    if (localText.length > 50 && indic / localText.length >= 0.05) {
      text = localText;
      console.log(`PDF text extracted via pdf-parse (${parsed.numpages} pages, no OCR needed)`);
    }
  } catch { /* fall through to OCR */ }

  // Step 2: image-only PDF — Claude vision OCR via the SDK.
  if (!text) {
    console.log('PDF appears to be image-only — running Claude vision OCR via Claude Max plan…');
    const { chunks: pdfChunks, totalPages } = await splitPdfIntoChunks(buf, PAGES_PER_OCR_CHUNK);
    console.log(`OCR plan: ${totalPages} pages → ${pdfChunks.length} chunk(s) of ≤${PAGES_PER_OCR_CHUNK} pages each`);
    const parts = [];
    for (let i = 0; i < pdfChunks.length; i++) {
      const { startPage, endPage } = pdfChunks[i];
      process.stdout.write(`  OCR chunk ${i + 1}/${pdfChunks.length} (pages ${startPage + 1}-${endPage})… `);
      const t = await ocrPdfBuffer(pdfChunks[i].buf);
      parts.push(t);
      process.stdout.write(`${t.split(/\s+/).filter(Boolean).length} words\n`);
    }
    text = parts.join('\n\n').trim();
  }
} else if (IMAGE_MEDIA_TYPES[ext]) {
  console.log(`Image input — running Claude vision OCR…`);
  const buf = readFileSync(absPath);
  text = await ocrImageBuffer(buf, IMAGE_MEDIA_TYPES[ext]);
  text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  console.log(`OCR complete — ${text.split(/\s+/).filter(Boolean).length} words extracted`);
} else {
  console.error(`Unsupported extension: ${ext}. Use .txt, .docx, .pdf, .png, .jpg, .jpeg, .webp, or .gif.`);
  process.exit(1);
}

if (!text.trim()) { console.error('No text in input.'); process.exit(1); }

const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
const filename = basename(absPath, ext);
console.log(`Input:  ${basename(absPath)}  (${wordCount.toLocaleString()} words)`);

// ── Chunker (verse-aware, mirrors lib/pipeline.ts deterministicChunk) ───────

function isVerseBlock(p) {
  const lines = p.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const quoted = lines.some(l => /^[“”"'‘’]/.test(l) && /[āīūṛṅñṭḍṇśṣḥ]/.test(l));
  const avg = lines.reduce((s, l) => s + l.length, 0) / lines.length;
  const sim = lines.length >= 2 && lines.every(l => Math.abs(l.length - avg) < avg * 0.5);
  const dia = lines.filter(l => /[āīūṛṅñṭḍṇśṣḥ]/.test(l)).length >= lines.length * 0.5;
  return quoted || (sim && dia);
}

function chunk(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.split(/\s+/).filter(Boolean).length <= 500) return [trimmed];
  let paras = trimmed.split(/\n\s*\n/);
  if (paras.some(p => p.trim().split(/\s+/).length > 500)) paras = trimmed.split(/\n/).filter(l => l.trim());
  const groups = [];
  let pending = null;
  for (const para of paras) {
    const p = para.trim(); if (!p) continue;
    if (isVerseBlock(p)) {
      if (groups.length > 0) groups[groups.length - 1] += '\n\n' + p;
      else pending = pending ? pending + '\n\n' + p : p;
    } else {
      if (pending) { groups.push(pending + '\n\n' + p); pending = null; }
      else groups.push(p);
    }
  }
  if (pending) groups.push(pending);
  const chunks = [];
  let cur = [], curWords = 0;
  for (const g of groups) {
    const w = g.split(/\s+/).length;
    if (curWords + w > 500 && curWords >= 300) { chunks.push(cur.join('\n\n')); cur = [g]; curWords = w; }
    else { cur.push(g); curWords += w; }
  }
  if (cur.length > 0) {
    if (curWords < 150 && chunks.length > 0) chunks[chunks.length - 1] += '\n\n' + cur.join('\n\n');
    else chunks.push(cur.join('\n\n'));
  }
  return chunks;
}

const chunks = chunk(text);
console.log(`Chunks: ${chunks.length}`);
console.log('');

// ── XML parsers ─────────────────────────────────────────────────────────────

function stripFences(raw) {
  let s = raw.trim();
  const m = s.match(/^```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  if (m) s = m[1].trim();
  return s;
}
function extractTag(source, tag, stage) {
  const open = `<${tag}>`, close = `</${tag}>`;
  const i = source.indexOf(open);
  if (i === -1) throw new Error(`[${stage}] missing <${tag}>`);
  const j = source.indexOf(close, i + open.length);
  if (j === -1) throw new Error(`[${stage}] missing </${tag}>`);
  return source.slice(i + open.length, j).trim();
}
function parseTranslator(raw) {
  const c = stripFences(raw);
  return { translation: extractTag(c, 'translation', 'translator') };
}
function parseSmoother(raw) {
  const c = stripFences(raw);
  return { smoothed: extractTag(c, 'smoothed', 'smoother') };
}
function parseTransliterator(raw) {
  const c = stripFences(raw);
  return { transliteration: extractTag(c, 'transliteration', 'transliterator') };
}

// ── Per-chunk pipelines ─────────────────────────────────────────────────────

async function translateChunk(g, i, n) {
  const raw = await callClaude({
    system: TRANSLATOR_SYSTEM,
    userPrompt: `Chunk ${i + 1} of ${n}. Translate the following Gujarati text into English following the rules above. For verse or poetic lines, include the Roman transliteration in curly quotes first, then the English meaning in parentheses — both mandatory. Output ONLY the two XML blocks: <translation>…</translation><flags>…</flags>.\n\nGUJARATI:\n${g}`,
  });
  return parseTranslator(raw).translation;
}
async function smoothChunk(t) {
  const raw = await callClaude({
    system: SMOOTHER_SYSTEM,
    userPrompt: `Smooth the following passage per the rules above. Output ONLY <smoothed>…</smoothed>.\n\n${t}`,
  });
  return parseSmoother(raw).smoothed;
}
async function transliterateChunk(g, i, n) {
  const raw = await callClaude({
    system: TRANSLITERATOR_SYSTEM,
    userPrompt: `Chunk ${i + 1} of ${n}. Transliterate the following Gujarati passage into Roman script per the rules above. Output ONLY <transliteration>…</transliteration>.\n\nGUJARATI:\n${g}`,
  });
  return parseTransliterator(raw).transliteration;
}

// ── Diacritic enforcer (ā only) ─────────────────────────────────────────────

const DIACRITICS_STRIP = {
  'ī': 'i', 'Ī': 'I', 'ū': 'u', 'Ū': 'U',
  'ṛ': 'ri', 'Ṛ': 'Ri', 'ṅ': 'n', 'Ṅ': 'N',
  'ñ': 'n', 'Ñ': 'N', 'ṭ': 't', 'Ṭ': 'T',
  'ḍ': 'd', 'Ḍ': 'D', 'ṇ': 'n', 'Ṇ': 'N',
  'ś': 'sh', 'Ś': 'Sh', 'ṣ': 'sh', 'Ṣ': 'Sh',
  'ḥ': 'h', 'Ḥ': 'H',
};
function stripForbiddenDiacritics(s) {
  for (const [from, to] of Object.entries(DIACRITICS_STRIP)) s = s.split(from).join(to);
  return s;
}
function preserveMacrons(translatorText, smootherText) {
  const M = /[Āā]/g;
  if ((translatorText.match(M) ?? []).length === 0) return smootherText;
  if ((smootherText.match(M) ?? []).length >= (translatorText.match(M) ?? []).length) return smootherText;
  const verseLines = translatorText.split('\n').filter(l => /[Āā]/.test(l));
  let patched = smootherText;
  for (const v of verseLines) {
    if (patched.includes(v)) continue;
    const stripped = v.replace(/Ā/g, 'A').replace(/ā/g, 'a');
    if (patched.includes(stripped)) patched = patched.replace(stripped, v);
  }
  return patched;
}

// ── Run pipelines ───────────────────────────────────────────────────────────

console.log('Running pipelines...');
const englishParts = new Array(chunks.length).fill('');
const translitParts = new Array(chunks.length).fill('');
const BATCH = 4;

for (let start = 0; start < chunks.length; start += BATCH) {
  const batch = chunks.slice(start, start + BATCH);
  await Promise.all(batch.map(async (g, k) => {
    const i = start + k;
    const tasks = [];
    if (!translitOnly) {
      tasks.push((async () => {
        const t1 = await translateChunk(g, i, chunks.length);
        let final = t1;
        if (!noSmoother) {
          try {
            const t2 = await smoothChunk(t1);
            final = preserveMacrons(t1, t2);
          } catch (e) {
            console.error(`  smoother fallback chunk ${i + 1}: ${e.message}`);
            final = t1;
          }
        }
        englishParts[i] = stripForbiddenDiacritics(final);
        process.stdout.write(`  ✓ EN  chunk ${i + 1}/${chunks.length}\n`);
      })());
    }
    if (!englishOnly) {
      tasks.push((async () => {
        const tl = await transliterateChunk(g, i, chunks.length);
        translitParts[i] = stripForbiddenDiacritics(tl);
        process.stdout.write(`  ✓ TR  chunk ${i + 1}/${chunks.length}\n`);
      })());
    }
    await Promise.all(tasks);
  }));
}

const englishOut = englishParts.filter(Boolean).join('\n\n');
const translitOut = translitParts.filter(Boolean).join('\n\n');

// ── DOCX writer ─────────────────────────────────────────────────────────────

const { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle } = await import('docx');

function buildDocx({ title, body, italiciseAll = false }) {
  const paragraphs = [];
  paragraphs.push(new Paragraph({
    text: title, heading: HeadingLevel.HEADING_1, spacing: { after: 200 },
  }));
  paragraphs.push(new Paragraph({
    children: [new TextRun({
      text: `Aksharpith Translation Pipeline · ${new Date().toLocaleDateString('en-GB')}`,
      size: 18, color: '888888', italics: true,
    })],
    spacing: { after: 300 },
  }));
  // Verse detection: a paragraph is a verse if any line is wrapped in <verse>
  // tags (transliteration output), OR (English output) starts with curly
  // quote + contains macron-a, OR consists of metrical lines with diacritics.
  const blocks = body.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim(); if (!trimmed) continue;
    const hasVerseTag = /<verse>[\s\S]*?<\/verse>/.test(trimmed);
    const looksLikeVerse = !hasVerseTag && (
      (/^[“”"'‘’]/.test(trimmed) && /[Āā]/.test(trimmed)) ||
      trimmed.split('\n').filter(l => /[Āā]/.test(l)).length >= 2
    );
    if (hasVerseTag || looksLikeVerse) {
      const lines = (hasVerseTag
        ? trimmed.replace(/<\/?verse>/g, '').split('\n')
        : trimmed.split('\n')).filter(l => l.trim());
      for (const line of lines) {
        const isMeaning = /^\(.*\)$/.test(line.trim());
        paragraphs.push(new Paragraph({
          children: [new TextRun({
            text: line, italics: !isMeaning,
            size: isMeaning ? 20 : 22,
            color: isMeaning ? '666666' : '333333',
            font: 'Garamond',
          })],
          indent: { left: 720 },
          border: { left: { style: BorderStyle.SINGLE, size: 6, color: 'CC9900', space: 10 } },
          spacing: { after: 60 },
        }));
      }
      paragraphs.push(new Paragraph({ spacing: { after: 200 } }));
    } else {
      paragraphs.push(new Paragraph({
        children: [new TextRun({
          text: trimmed, size: 24, font: 'Garamond', italics: italiciseAll,
        })],
        spacing: { after: 200, line: 360 },
      }));
    }
  }
  return new Document({ sections: [{ properties: {}, children: paragraphs }] });
}

async function writeDocx(doc, path) {
  const buffer = await Packer.toBuffer(doc);
  writeFileSync(path, buffer);
}

// ── Outputs ─────────────────────────────────────────────────────────────────

const outputDir = dirname(absPath);
const written = [];

if (englishOut.trim()) {
  const txtPath = join(outputDir, `${filename}-english.txt`);
  const docxPath = join(outputDir, `${filename}-english.docx`);
  writeFileSync(txtPath, englishOut + '\n', 'utf-8');
  await writeDocx(buildDocx({ title: filename, body: englishOut }), docxPath);
  written.push(txtPath, docxPath);
}

if (translitOut.trim()) {
  // Strip <verse> tags from TXT output (markup is for DOCX renderer only)
  const txtClean = translitOut.replace(/<\/?verse>/g, '');
  const txtPath = join(outputDir, `${filename}-translit.txt`);
  const docxPath = join(outputDir, `${filename}-translit.docx`);
  writeFileSync(txtPath, txtClean + '\n', 'utf-8');
  await writeDocx(buildDocx({ title: `${filename} — Transliteration`, body: translitOut }), docxPath);
  written.push(txtPath, docxPath);
}

console.log('');
console.log('Done. Files:');
for (const p of written) console.log(`  ${p}`);
