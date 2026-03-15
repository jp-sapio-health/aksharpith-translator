import https from 'node:https';
import mammoth from 'mammoth';
import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';

export const dynamic    = 'force-dynamic';
export const maxDuration = 120; // large files + Claude extraction

// ── Size limits ───────────────────────────────────────────────────────────────

const MAX_FILE_SIZE  = 100 * 1024 * 1024; // 100MB (Vercel Pro)
const MAX_CLAUDE_PDF = 32  * 1024 * 1024; // Claude API limit for PDFs
const MAX_CLAUDE_IMG = 20  * 1024 * 1024; // Claude API limit for images

// ── Supported image types for Claude vision ───────────────────────────────────

const IMAGE_MEDIA: Record<string, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
};

// ── Claude extraction (PDF + image OCR) ───────────────────────────────────────

function callClaudeExtract(
  apiKey: string, base64: string, mediaType: string, prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const isImage = mediaType.startsWith('image/');
    const contentBlock = isImage
      ? { type: 'image',    source: { type: 'base64', media_type: mediaType, data: base64 } }
      : { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } };

    const body = JSON.stringify({
      model:      'claude-haiku-4-5-20251001', // Haiku: fast extraction, Sonnet reserved for translation
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
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Claude ${res.statusCode}: ${raw.slice(0, 300)}`));
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

// ── Extraction prompts ────────────────────────────────────────────────────────

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

// ── Chapter detection ─────────────────────────────────────────────────────────

const SECTION_WORDS = 4000;

function detectChapters(text: string): Array<{ title: string; startLine: number }> {
  const lines = text.split('\n');
  const markerPattern   = /^===\s*CHAPTER:\s*(.+?)\s*===$/i;
  const numberedPattern = /^(?:chapter\s+\d+[:\s]|(\d{1,2})[.)]\s+\S)/i;

  const chapters: Array<{ title: string; startLine: number }> = [];
  const skip = Math.min(50, Math.floor(lines.length * 0.05));

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
    const span   = chapters[chapters.length - 1].startLine - chapters[0].startLine;
    const avgGap = span / chapters.length;
    if (avgGap > 30) return chapters;
  }

  return splitByWordCount(lines, SECTION_WORDS);
}

function splitByWordCount(lines: string[], targetWords: number): Array<{ title: string; startLine: number }> {
  const sections: Array<{ title: string; startLine: number }> = [];
  let wordsSinceLastSplit = 0;
  let sectionIndex = 1;
  const skip = Math.min(50, Math.floor(lines.length * 0.05));
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

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const authUser = await verifyAuthToken(req);
    if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return Response.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });

    const formData = await req.formData().catch(() => null);
    if (!formData) return Response.json({ error: 'Invalid form data' }, { status: 400 });

    const file = formData.get('file') as File | null;
    if (!file || !file.name) return Response.json({ error: 'No file provided' }, { status: 400 });

    // ── Size validation ─────────────────────────────────────────────
    if (file.size > MAX_FILE_SIZE) {
      return Response.json({
        error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 100 MB.`,
      }, { status: 400 });
    }

    if (file.size === 0) {
      return Response.json({ error: 'File is empty.' }, { status: 400 });
    }

    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const buf = Buffer.from(await file.arrayBuffer());
    let extracted = '';

    // ── PDF: Claude vision (handles multi-page natively, up to 100 pages)
    if (ext === 'pdf') {
      if (buf.length > MAX_CLAUDE_PDF) {
        return Response.json({
          error: `PDF too large for extraction (${(buf.length / 1024 / 1024).toFixed(1)} MB). Maximum PDF size is 32 MB. Split the PDF into smaller files.`,
        }, { status: 400 });
      }
      extracted = await callClaudeExtract(apiKey, buf.toString('base64'), 'application/pdf', PDF_PROMPT);
    }

    // ── Images: Claude vision OCR (PNG, JPG, WEBP, GIF)
    else if (IMAGE_MEDIA[ext]) {
      if (buf.length > MAX_CLAUDE_IMG) {
        return Response.json({
          error: `Image too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Maximum image size is 20 MB.`,
        }, { status: 400 });
      }
      extracted = await callClaudeExtract(apiKey, buf.toString('base64'), IMAGE_MEDIA[ext], IMAGE_PROMPT);
    }

    // ── DOCX: mammoth
    else if (ext === 'docx') {
      extracted = (await mammoth.extractRawText({ buffer: buf })).value;
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
    const wordCount = extracted.trim().split(/\s+/).length;

    return Response.json({
      text:       extracted,
      filename:   file.name,
      wordCount,
      chapters:   chapters.length > 1 ? chapters : null,
      isBookMode: wordCount > 3000,
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Upload error:', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
