#!/usr/bin/env node
/**
 * Test a local file through the translation pipeline.
 * Creates job(s) in Firestore with mode:'local' — the local worker picks them up.
 *
 * Usage:
 *   node scripts/test-file.mjs <file-path>              — single file
 *   node scripts/test-file.mjs <file-path> --watch       — watch for completion
 *   node scripts/test-file.mjs <file-path> --output out.txt — save output to file
 *
 * Supported formats: .txt, .docx
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith('--'));
const watchMode = args.includes('--watch');
const outputIdx = args.indexOf('--output');
const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;

if (!filePath) {
  console.log('Usage: node scripts/test-file.mjs <file-path> [--watch] [--output <path>]');
  console.log('');
  console.log('Supported: .txt, .docx');
  console.log('Creates jobs in Firestore with mode:local — the local worker processes them.');
  process.exit(1);
}

const absPath = resolve(filePath);
if (!existsSync(absPath)) {
  console.error(`File not found: ${absPath}`);
  process.exit(1);
}

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

const PROJECT_ID = env.FIREBASE_PROJECT_ID || 'aksharpith-translator';
const CLIENT_EMAIL = env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (!CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY in .env files');
  process.exit(1);
}

// ── Firebase Admin ───────────────────────────────────────────────────────────

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  initializeApp({ credential: cert({ projectId: PROJECT_ID, clientEmail: CLIENT_EMAIL, privateKey: PRIVATE_KEY }) });
}
const db = getFirestore();

// ── Extract text ─────────────────────────────────────────────────────────────

const ext = extname(absPath).toLowerCase();
let text = '';

if (ext === '.txt') {
  text = readFileSync(absPath, 'utf-8');
} else if (ext === '.docx') {
  try {
    const mammoth = await import('mammoth');
    const buf = readFileSync(absPath);
    const result = await mammoth.default.convertToHtml({ buffer: buf });
    text = result.value
      .replace(/<\/p>/g, '\n\n')
      .replace(/<br\/>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (e) {
    console.error('Failed to read .docx file:', e.message);
    console.log('Make sure mammoth is installed: npm install mammoth');
    process.exit(1);
  }
} else {
  console.error(`Unsupported file type: ${ext}. Use .txt or .docx`);
  process.exit(1);
}

if (!text.trim()) {
  console.error('No text extracted from file.');
  process.exit(1);
}

const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
const filename = basename(absPath);
console.log(`File: ${filename}`);
console.log(`Words: ${wordCount.toLocaleString()}`);
console.log(`Estimated chunks: ${Math.ceil(wordCount / 500)}`);
console.log('');

// ── Detect chapters ──────────────────────────────────────────────────────────

function detectChapters(text) {
  const lines = text.split('\n');
  const markerPattern = /^===\s*CHAPTER:\s*(.+?)\s*===$/i;
  const numberedPattern = /^(?:chapter\s+\d+[:\s]|(\d{1,2})[.)]\s+\S)/i;
  const chapters = [];
  const skip = Math.min(50, Math.floor(lines.length * 0.05));
  if (skip >= lines.length) return [];

  for (let i = skip; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const markerMatch = line.match(markerPattern);
    if (markerMatch) { chapters.push({ title: markerMatch[1], startLine: i }); continue; }
    const numberedMatch = line.match(numberedPattern);
    if (numberedMatch && line.split(/\s+/).length <= 12) {
      chapters.push({ title: line.replace(/^(?:chapter\s+\d+[:\s.]|\d{1,2}[.)]\s*)/, '').trim() || line, startLine: i });
    }
  }

  if (chapters.length > 1) {
    const span = chapters[chapters.length - 1].startLine - chapters[0].startLine;
    const avgGap = span / chapters.length;
    if (avgGap > 30) return chapters;
  }
  return [];
}

const chapters = detectChapters(text);
const lines = text.split('\n');

// ── Create job(s) ────────────────────────────────────────────────────────────

const bookRunId = crypto.randomUUID();
const jobIds = [];

if (chapters.length > 1) {
  console.log(`Detected ${chapters.length} chapters — creating ${chapters.length} jobs`);
  console.log('');

  for (let i = 0; i < chapters.length; i++) {
    const start = chapters[i].startLine;
    const end = chapters[i + 1]?.startLine ?? lines.length;
    const chText = lines.slice(start, end).join('\n').trim();
    if (!chText) continue;

    const chWords = chText.trim().split(/\s+/).filter(Boolean).length;
    const jobRef = await db.collection('jobs').add({
      status: 'pending',
      mode: 'local',
      uid: 'local-test',
      email: 'local-test@cli',
      input: {
        text: chText, wordCount: chWords,
        chapterTitle: chapters[i].title,
        bookId: bookRunId, bookTitle: filename,
        chapterIndex: i, totalChapters: chapters.length,
      },
      createdAt: new Date().toISOString(),
      startedAt: null, completedAt: null, error: null,
      progress: { currentStage: 'pending', stages: {}, chunks: [] },
      result: null,
    });
    jobIds.push(jobRef.id);
    console.log(`  [${i + 1}] "${chapters[i].title}" — ${chWords.toLocaleString()} words → job ${jobRef.id}`);
  }
} else {
  console.log('Single section — creating 1 job');
  const jobRef = await db.collection('jobs').add({
    status: 'pending',
    mode: 'local',
    uid: 'local-test',
    email: 'local-test@cli',
    input: {
      text, wordCount,
      chapterTitle: filename.replace(/\.[^.]+$/, ''),
      bookId: bookRunId, bookTitle: filename,
      chapterIndex: 0, totalChapters: 1,
    },
    createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null, error: null,
    progress: { currentStage: 'pending', stages: {}, chunks: [] },
    result: null,
  });
  jobIds.push(jobRef.id);
  console.log(`  Job: ${jobRef.id}`);
}

console.log('');
console.log(`Created ${jobIds.length} job(s) with mode:local`);
console.log('The local worker will pick these up automatically.');

// ── Watch mode ───────────────────────────────────────────────────────────────

if (watchMode || outputPath) {
  console.log('');
  console.log('Watching for completion...');

  const completed = new Set();
  const outputs = new Array(jobIds.length).fill('');

  while (completed.size < jobIds.length) {
    await new Promise(r => setTimeout(r, 3000));

    for (let i = 0; i < jobIds.length; i++) {
      if (completed.has(i)) continue;
      const doc = await db.collection('jobs').doc(jobIds[i]).get();
      const data = doc.data();

      if (data.status === 'running') {
        const stage = data.progress?.currentStage ?? '?';
        const chunks = data.progress?.stages?.translator?.total ?? '?';
        const tDone = data.progress?.stages?.translator?.completed ?? 0;
        process.stdout.write(`\r  [${i + 1}/${jobIds.length}] ${stage} (${tDone}/${chunks} chunks)   `);
      }

      if (data.status === 'completed') {
        completed.add(i);
        outputs[i] = data.result?.output ?? '';
        const score = data.result?.avgScore ?? '?';
        const words = data.result?.wordCount ?? '?';
        console.log(`\n  [${i + 1}/${jobIds.length}] DONE — ${words} words, score: ${score}`);
      }

      if (data.status === 'failed') {
        completed.add(i);
        console.log(`\n  [${i + 1}/${jobIds.length}] FAILED — ${data.error}`);
      }
    }
  }

  const combined = outputs.filter(Boolean).join('\n\n');

  if (outputPath) {
    writeFileSync(resolve(outputPath), combined, 'utf-8');
    console.log(`\nOutput saved to: ${outputPath}`);
  }

  console.log(`\nAll ${jobIds.length} jobs finished.`);
  console.log(`Total output: ${combined.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words`);
  process.exit(0);
} else {
  console.log('Use --watch to wait for results, or --output <path> to save output.');
  process.exit(0);
}
