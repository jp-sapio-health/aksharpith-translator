import https from 'node:https';
import mammoth from 'mammoth';
import { PDFDocument } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ numpages: number; text: string }>;
import { NextRequest } from 'next/server';
import { del as blobDelete, put as blobPut } from '@vercel/blob';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';
import type { TransliterationJobDocument, PageJob } from '../../../lib/job-types';

export const dynamic    = 'force-dynamic';
export const maxDuration = 300;

// ─── Size limits ───────────────────────────────────────────────────────────────

const MAX_FILE_SIZE  = 100 * 1024 * 1024; // 100MB (Vercel Pro)
const MAX_CLAUDE_PDF = 32  * 1024 * 1024; // Claude API limit for PDFs
const MAX_CLAUDE_IMG = 20  * 1024 * 1024; // Claude API limit for images
const API_TIMEOUT_MS = 240_000;           // 240s timeout for extraction (large PDFs)

// ─── Supported image types for Claude vision ───────────────────────────────────

const IMAGE_MEDIA: Record<string, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
};

// ─── PDF page splitting ─────────────────────────────────────────────────────────

async function splitPdfIntoChunks(buf: Buffer, pagesPerChunk: number): Promise<Buffer[]> {
  const srcDoc = await PDFDocument.load(buf);
  const totalPages = srcDoc.getPageCount();
  const chunks: Buffer[] = [];

  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages);
    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(srcDoc, Array.from({ length: end - start }, (_, i) => start + i));
    for (const page of pages) newDoc.addPage(page);
    const bytes = await newDoc.save();
    chunks.push(Buffer.from(bytes));
  }

  return chunks;
}

// ─── Claude extraction (PDF + image OCR) ───────────────────────────────────────

function callClaudeExtractOnce(
  apiKey: string, base64: string, mediaType: string, prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const isImage = mediaType.startsWith('image/');
    const contentBlock = isImage
      ? { type: 'image',    source: { type: 'base64', media_type: mediaType, data: base64 } }
      : { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } };

    const body = JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 16000,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
    });

    const headers: Record<string, string | number> = {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
      'content-length':    Buffer.byteLength(body),
    };
    if (!isImage) headers['anthropic-beta'] = 'pdfs-2024-09-25';

    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          // Log full upstream detail server-side for debugging; do not echo it
          // to clients (Sapio SECURITY: never expose internal structure).
          console.error(`[upload] Anthropic ${res.statusCode ?? 0}: ${raw.slice(0, 500)}`);
          const err = new Error('Claude extraction failed') as Error & { statusCode?: number };
          err.statusCode = res.statusCode ?? 0;
          reject(err);
          return;
        }
        try {
          const data = JSON.parse(raw) as { content?: Array<{ type: string; text?: string }> };
          const text = data.content?.[0]?.text?.trim();
          if (!text) { reject(new Error('Empty response from Claude extraction')); return; }
          resolve(text);
        } catch { reject(new Error('Parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.setTimeout(API_TIMEOUT_MS, () => { req.destroy(); reject(new Error('Claude extraction timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}


// ─── HTML entity decoder ─────────────────────────────────────────────────────

function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&hellip;/g, '\u2026');
}

// ─── Extraction prompts ────────────────────────────────────────────────────────

const PDF_PROMPT = `Extract ALL text from this PDF document exactly as written. Preserve:
- Every paragraph (blank line between paragraphs)
- All Gujarati Unicode text exactly as it appears
- All numbers, dates, names, verses
- Chapter/section headings (mark as "=== CHAPTER: <title> ===" on its own line)
- Slide markers (e.g. "Slide 2:", "Slide 3:") preserved exactly
- Verse/kirtan lines on separate lines
- Table content with structure

Return ONLY the extracted text — no commentary, no notes, no preamble.`;

const IMAGE_PROMPT = `Extract ALL text from this image exactly as written. This may be a scan or photograph of a document containing Gujarati and/or English text. Preserve:
- All Gujarati Unicode text exactly
- All English text exactly
- All numbers, dates, names
- Paragraph breaks and structure
- Any headings, bullet points, or numbered lists

Return ONLY the extracted text — no commentary, no notes, no preamble.`;

// ─── Chapter detection ─────────────────────────────────────────────────────────

const SECTION_WORDS = 4000;

function detectChapters(text: string): Array<{ title: string; startLine: number }> {
  const lines = text.split('\n');
  const skip = Math.min(50, Math.floor(lines.length * 0.05));
  if (skip >= lines.length) return splitByWordCount(lines, SECTION_WORDS);

  // ── Strategy 1: Claude PDF extraction markers ──
  const markerPattern = /^===\s*CHAPTER:\s*(.+?)\s*===$/i;
  const markerChapters: Array<{ title: string; startLine: number }> = [];
  for (let i = skip; i < lines.length; i++) {
    const m = lines[i].trim().match(markerPattern);
    if (m) markerChapters.push({ title: m[1], startLine: i });
  }
  if (markerChapters.length > 1) return markerChapters;

  // ── Strategy 2: TOC-based detection ──
  // Look for a table of contents with pattern: "N.\t<title>" on consecutive lines
  const tocPattern = /^(\d{1,2})\.\t(.+)/;
  const tocEntries: Array<{ num: number; title: string; tocLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(tocPattern);
    if (m) {
      const num = parseInt(m[1], 10);
      const title = m[2].trim();
      // TOC entries should be roughly consecutive (within 4 lines of each other)
      if (tocEntries.length === 0 || i - tocEntries[tocEntries.length - 1].tocLine < 8) {
        tocEntries.push({ num, title, tocLine: i });
      }
    }
  }

  if (tocEntries.length >= 3) {
    // Use TOC titles to find chapter starts in the body (after the TOC)
    const tocEnd = tocEntries[tocEntries.length - 1].tocLine + 5;
    const tocChapters: Array<{ title: string; startLine: number }> = [];

    for (const entry of tocEntries) {
      // Extract first few significant words from TOC title for matching
      const titleWords = entry.title.replace(/[\t\d.…]+$/, '').trim().split(/\s+/).slice(0, 4).join(' ');
      if (titleWords.length < 3) continue;

      // Search body for a line containing these words (after TOC)
      for (let i = tocEnd; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const prevBlank = i > 0 && !lines[i - 1].trim();
        if (prevBlank && line.includes(titleWords)) {
          // Verify it's not a footnote or reference (should be a heading-like line)
          const words = line.split(/\s+/).length;
          if (words <= 15) {
            tocChapters.push({ title: line, startLine: i });
            break;
          }
        }
      }
    }

    if (tocChapters.length >= 3) {
      const span = tocChapters[tocChapters.length - 1].startLine - tocChapters[0].startLine;
      const avgGap = span / tocChapters.length;
      if (avgGap > 20) return tocChapters;
    }
  }

  // ── Strategy 3: Numbered headings (English or Gujarati) ──
  const numberedPattern = /^(?:chapter\s+\d+[:\s]|(\d{1,2})[.)]\s+\S)/i;
  const numChapters: Array<{ title: string; startLine: number }> = [];
  for (let i = skip; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.match(numberedPattern);
    if (m && line.split(/\s+/).length <= 12) {
      numChapters.push({ title: line.replace(/^(?:chapter\s+\d+[:\s.]|\d{1,2}[.)]\s*)/, '').trim() || line, startLine: i });
    }
  }
  if (numChapters.length > 1) {
    const span = numChapters[numChapters.length - 1].startLine - numChapters[0].startLine;
    const avgGap = span / numChapters.length;
    if (avgGap > 30) return numChapters;
  }

  // ── Strategy 4: Fallback — split by word count ──
  return splitByWordCount(lines, SECTION_WORDS);
}

function splitByWordCount(lines: string[], targetWords: number): Array<{ title: string; startLine: number }> {
  const sections: Array<{ title: string; startLine: number }> = [];
  let wordsSinceLastSplit = 0;
  let sectionIndex = 1;
  const skip = Math.min(50, Math.floor(lines.length * 0.05));

  if (skip >= lines.length) return [];

  sections.push({ title: 'Section 1', startLine: skip });

  for (let i = skip; i < lines.length; i++) {
    wordsSinceLastSplit += lines[i].trim().split(/\s+/).filter(Boolean).length;
    if (wordsSinceLastSplit >= targetWords) {
      let splitAt = i;
      for (let j = i; j < Math.min(i + 20, lines.length); j++) {
        if (!lines[j].trim()) { splitAt = j + 1; break; }
      }
      if (splitAt > i && splitAt < lines.length) {
        sectionIndex++;
        sections.push({ title: `Section ${sectionIndex}`, startLine: splitAt });
        wordsSinceLastSplit = 0;
        i = splitAt - 1;
      }
    }
  }

  return sections.length > 1 ? sections : [];
}

// ─── Transliteration job creation (page-by-page pipeline) ─────────────────────
//
// All PDFs route through this path now. The route uploads the buffer to Vercel
// Blob (if not already there), counts pages, and creates a parent job doc plus
// N child page docs. The local worker picks up the page jobs, OCRs each page
// via the Claude Agent SDK (Max plan, no API spend), assembles the Gujarati
// text, runs it through the transliterator, and writes the output back.
//
// Returns `{ jobId, totalPages, status: 'transliterating', filename }` so the
// client can switch from the upload phase to a Firestore subscription on the
// new job document.

async function enqueueTransliterationJob(params: {
  buf: Buffer;
  filename: string;
  uid: string;
  email: string;
  blobUrl?: string;        // present when client uploaded via Blob first
}): Promise<{ jobId: string; totalPages: number }> {
  const { buf, filename, uid, email } = params;

  // Count pages — pdf-lib is the source of truth (more reliable than pdf-parse
  // on encrypted / weird-font PDFs which we still want to OCR).
  let totalPages = 0;
  try {
    totalPages = (await PDFDocument.load(buf, { ignoreEncryption: true })).getPageCount();
  } catch (err) {
    throw new Error(`Could not parse PDF structure: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  if (totalPages === 0) throw new Error('PDF has zero pages');

  // Ensure the worker can fetch the buffer over HTTPS. If the client already
  // uploaded via Blob we have the URL; otherwise upload now.
  let pdfBlobUrl = params.blobUrl;
  if (!pdfBlobUrl) {
    const safeName = filename.replace(/[^\w.\- ]+/g, '_');
    const blob = await blobPut(`uploads/${uid}/${Date.now()}_${safeName}`, buf, {
      access: 'public',
      contentType: 'application/pdf',
    });
    pdfBlobUrl = blob.url;
  }

  // Atomic-ish parent + page docs creation. We accept the race window because
  // the worker only claims pages with status 'pending' under a transaction.
  const jobRef = adminDb.collection('transliterationJobs').doc();
  const jobId = jobRef.id;
  const now = new Date().toISOString();

  const parent: TransliterationJobDocument = {
    kind: 'transliteration',
    uid, email, filename, pdfBlobUrl, totalPages,
    status: 'pending',
    pagesCompleted: 0,
    createdAt: now,
  };
  await jobRef.set(parent);

  // Page docs in batches of 500 (Firestore batch limit).
  const BATCH = 500;
  for (let start = 0; start < totalPages; start += BATCH) {
    const batch = adminDb.batch();
    const end = Math.min(start + BATCH, totalPages);
    for (let i = start; i < end; i++) {
      const pageNum = i + 1;
      const pageRef = jobRef.collection('pages').doc(String(pageNum).padStart(4, '0'));
      const page: PageJob = {
        pageNum,
        status: 'pending',
        attempts: 0,
        createdAt: now,
      };
      batch.set(pageRef, page);
    }
    await batch.commit();
  }

  return { jobId, totalPages };
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const authUser = await verifyAuthToken(req);
    if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return Response.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });

    // Two intake paths:
    //  1. multipart/form-data — small files (≤4.5 MB Vercel body cap) sent inline.
    //  2. application/json { blobUrl, filename } — large files staged via
    //     Vercel Blob by the client to bypass the body-size limit.
    const contentType = req.headers.get('content-type') ?? '';
    let buf: Buffer;
    let filename: string;
    let blobUrlToCleanup: string | null = null;

    if (contentType.includes('application/json')) {
      const body = await req.json().catch(() => null) as { blobUrl?: string; filename?: string } | null;
      if (!body?.blobUrl || !body?.filename) {
        return Response.json({ error: 'Missing blobUrl or filename' }, { status: 400 });
      }
      // Defence-in-depth: reject any URL that isn't a Vercel Blob host. The
      // client SDK only ever returns *.public.blob.vercel-storage.com URLs.
      try {
        const u = new URL(body.blobUrl);
        if (!u.hostname.endsWith('.public.blob.vercel-storage.com')) {
          return Response.json({ error: 'Invalid blob URL host' }, { status: 400 });
        }
      } catch {
        return Response.json({ error: 'Invalid blob URL' }, { status: 400 });
      }
      try {
        const res = await fetch(body.blobUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        buf = Buffer.from(ab);
      } catch (err) {
        console.error('[upload] blob fetch failed:', err);
        return Response.json({ error: 'Could not retrieve uploaded file' }, { status: 502 });
      }
      filename = body.filename;
      blobUrlToCleanup = body.blobUrl;
      if (buf.length > MAX_FILE_SIZE) {
        return Response.json({
          error: `File too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Maximum is 100 MB.`,
        }, { status: 400 });
      }
      if (buf.length === 0) {
        return Response.json({ error: 'File is empty.' }, { status: 400 });
      }
    } else {
      const formData = await req.formData().catch(() => null);
      if (!formData) return Response.json({ error: 'Invalid form data' }, { status: 400 });

      const fileField = formData.get('file');
      if (!fileField || typeof fileField === 'string' || !('arrayBuffer' in fileField)) {
        return Response.json({ error: 'No file provided' }, { status: 400 });
      }
      const file = fileField as File;
      if (!file.name) return Response.json({ error: 'No file provided' }, { status: 400 });

      if (file.size > MAX_FILE_SIZE) {
        return Response.json({
          error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 100 MB.`,
        }, { status: 400 });
      }
      if (file.size === 0) {
        return Response.json({ error: 'File is empty.' }, { status: 400 });
      }

      try {
        buf = Buffer.from(await file.arrayBuffer());
      } catch {
        return Response.json({ error: 'Could not read file. The upload may be corrupted.' }, { status: 400 });
      }
      filename = file.name;
    }

    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    if (!ext) {
      return Response.json({ error: 'File has no extension. Supported formats: PDF, DOCX, DOC, TXT, PNG, JPG, WEBP, GIF' }, { status: 400 });
    }

    // From here on the handler treats `buf` and `filename` uniformly regardless
    // of intake path. The only remaining `file.size` / `file.name` references
    // below need to be replaced with `buf.length` / `filename`.

    let extracted = '';

    // ── PDF: route into the new transliteration-first pipeline.
    // The local worker (Claude Max plan) does page-by-page OCR — no API spend,
    // no Vercel timeout, page-level retries. Client subscribes to
    // transliterationJobs/{jobId} for live progress.
    if (ext === 'pdf') {
      try {
        const { jobId, totalPages } = await enqueueTransliterationJob({
          buf, filename,
          uid: authUser.uid, email: authUser.email,
          blobUrl: blobUrlToCleanup ?? undefined,
        });
        // Don't delete the staged blob — the worker needs to fetch from it.
        blobUrlToCleanup = null;
        return Response.json({
          jobId,
          totalPages,
          filename,
          status: 'transliterating',
          message: `PDF queued — ${totalPages} pages will OCR via local worker.`,
        });
      } catch (err) {
        console.error('[upload] enqueueTransliterationJob failed:', err);
        return Response.json({
          error: 'Could not queue this PDF for processing. Please retry.',
        }, { status: 500 });
      }
    }

    // ── Legacy PDF inline-OCR path — kept for reference but unreachable
    // because the branch above returns. Remove in a follow-up once the new
    // pipeline is proven on Jay's library.
    if (ext === '__legacy_pdf_unreachable__') {
      let pdfPages = 0;

      // Try local extraction (fast, no API cost, no token limit)
      try {
        const pdfData = await pdfParse(buf);
        pdfPages = pdfData.numpages ?? 0;
        const localText = pdfData.text?.trim() ?? '';
        // Check if extracted text contains actual Gujarati/Devanagari Unicode
        // Legacy font PDFs produce Latin-looking garbage (e.g. "CëÞUÝëÜ") that passes ASCII checks
        // Require at least 5% real Gujarati/Devanagari characters to consider it valid
        const gujaratiChars = localText.match(/[\u0A80-\u0AFF]/g)?.length ?? 0;
        const devanagariChars = localText.match(/[\u0900-\u097F]/g)?.length ?? 0;
        const indicRatio = (gujaratiChars + devanagariChars) / localText.length;
        const validUnicode = localText.length > 50 && indicRatio > 0.05;
        if (validUnicode) {
          extracted = localText
            .replace(/\r\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }
      } catch {
        // pdf-parse failed — fall through to Claude
      }

      // If local extraction failed or garbled, use Claude OCR
      if (!extracted) {
        // Resolve page count: pdf-parse may have left pdfPages=0 on image-only PDFs.
        if (!pdfPages) {
          try { pdfPages = (await PDFDocument.load(buf)).getPageCount(); } catch { /* leave at 0 */ }
        }

        // Anthropic PDF support has a 200k-token context window. Empirically a
        // BAPS Gujarati page is ~2-3k tokens at full visual fidelity, so 30
        // pages per call leaves headroom. Larger PDFs are split and joined.
        const PAGES_PER_CALL = 30;

        if (buf.length <= MAX_CLAUDE_PDF && pdfPages > 0 && pdfPages <= PAGES_PER_CALL) {
          // Small enough for a single Haiku call.
          extracted = await callClaudeExtractOnce(apiKey, buf.toString('base64'), 'application/pdf', PDF_PROMPT);
        } else if (buf.length <= MAX_CLAUDE_PDF && pdfPages > PAGES_PER_CALL) {
          // Multi-chunk: split into N-page slices, OCR each via Haiku, join.
          const pdfChunks = await splitPdfIntoChunks(buf, PAGES_PER_CALL);
          const texts: string[] = [];
          for (const chunkBuf of pdfChunks) {
            texts.push(await callClaudeExtractOnce(apiKey, chunkBuf.toString('base64'), 'application/pdf', PDF_PROMPT));
          }
          extracted = texts.join('\n\n');
        } else if (process.env.VERCEL === '1') {
          // > 32 MB on Vercel — local-worker path is unreachable here (Vercel
          // FS is read-only outside /tmp and the worker watches a different
          // machine). Surface a clean JSON error instead of crashing.
          return Response.json({
            error: `PDF is ${(buf.length / 1024 / 1024).toFixed(1)} MB / ${pdfPages || '?'} pages, over the ${(MAX_CLAUDE_PDF / 1024 / 1024).toFixed(0)} MB serverless limit. Please run the app locally (npm run dev) and re-upload.`,
          }, { status: 413 });
        } else {
          // > 32 MB on a local machine — write to disk for the local worker.
          try {
            const { writeFileSync, mkdirSync } = await import('node:fs');
            const { resolve: resolvePath } = await import('node:path');
            const extractionId = `extract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const extractDir = resolvePath(process.cwd(), 'extractions');
            mkdirSync(extractDir, { recursive: true });
            const filePath = resolvePath(extractDir, `${extractionId}.pdf`);
            writeFileSync(filePath, buf);

            await adminDb.collection('extractions').doc(extractionId).set({
              status: 'pending',
              filename,
              filePath,
              mediaType: 'application/pdf',
              pages: pdfPages,
              fileSizeBytes: buf.length,
              createdAt: new Date().toISOString(),
            });
            return Response.json({
              extractionId,
              status: 'extracting_locally',
              filename,
              pages: pdfPages,
              message: `PDF is ${pdfPages} pages — sending to local worker for extraction (no timeout limits)`,
            });
          } catch {
            return Response.json({
              error: 'Could not stage this PDF for the local worker. Please retry, or use a smaller PDF.',
            }, { status: 500 });
          }
        }
      }
    }

    // ── Images: Claude vision OCR (PNG, JPG, WEBP, GIF)
    else if (IMAGE_MEDIA[ext]) {
      if (buf.length > MAX_CLAUDE_IMG) {
        return Response.json({
          error: `Image too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Maximum image size is 20 MB.`,
        }, { status: 400 });
      }
      extracted = await callClaudeExtractOnce(apiKey, buf.toString('base64'), IMAGE_MEDIA[ext], IMAGE_PROMPT);
    }

    // ── DOCX: mammoth (preserving paragraph breaks)
    else if (ext === 'docx') {
      try {
        const result = await mammoth.convertToHtml({ buffer: buf });
        extracted = decodeHtmlEntities(
          result.value
            .replace(/<\/p>/g, '\n\n')
            .replace(/<br\/>/g, '\n')
            .replace(/<[^>]+>/g, '')
        )
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      } catch {
        return Response.json({
          error: 'Could not read this DOCX file. It may be corrupted or password-protected. Try re-saving it or converting to PDF.',
        }, { status: 422 });
      }
    }

    // ── DOC (legacy): attempt mammoth, graceful fallback
    else if (ext === 'doc') {
      try {
        extracted = (await mammoth.extractRawText({ buffer: buf })).value;
      } catch {
        return Response.json({
          error: 'Legacy .doc format is not supported. Please save as .docx or PDF and re-upload.',
        }, { status: 400 });
      }
    }

    // ── Plain text
    else if (ext === 'txt') {
      extracted = buf.toString('utf-8');
    }

    // ── Unsupported
    else {
      const supported = 'PDF, DOCX, DOC, TXT, PNG, JPG, WEBP, GIF';
      return Response.json({
        error: `Unsupported file type: .${ext}. Supported formats: ${supported}`,
      }, { status: 400 });
    }

    // ── Validate extraction ─────────────────────────────────────────
    if (!extracted.trim()) {
      return Response.json({
        error: 'No text could be extracted from this file. If this is a scanned document, try uploading as a high-resolution image (PNG or JPG).',
      }, { status: 422 });
    }

    const chapters  = detectChapters(extracted);
    const wordCount = extracted.trim().split(/\s+/).filter(Boolean).length;

    // Successfully extracted — clean up the staged Blob so we don't leak
    // storage. Failures here are non-fatal; just log.
    if (blobUrlToCleanup) {
      try { await blobDelete(blobUrlToCleanup); }
      catch (err) { console.warn('[upload] blob cleanup failed:', err); }
    }

    return Response.json({
      text:       extracted,
      filename,
      wordCount,
      chapters:   chapters.length > 1 ? chapters : null,
      isBookMode: wordCount > 3000,
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Upload error:', msg);
    // Don't expose error message to client — Sapio SECURITY (no internal detail).
    return Response.json({ error: 'Upload failed. Please retry.' }, { status: 500 });
  }
}
