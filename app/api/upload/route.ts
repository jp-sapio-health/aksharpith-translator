import https from 'node:https';
import mammoth from 'mammoth';
import { NextRequest } from 'next/server';

export const dynamic    = 'force-dynamic';
export const maxDuration = 60;

// ── Claude PDF extraction ──────────────────────────────────────────────────────

function callClaudeWithDoc(apiKey: string, base64: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) { reject(new Error(`Claude ${res.statusCode}: ${raw.slice(0, 200)}`)); return; }
        try {
          const data = JSON.parse(raw) as { content: Array<{ type: string; text: string }> };
          resolve(data.content?.[0]?.text?.trim() ?? '');
        } catch { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Chapter detection ─────────────────────────────────────────────────────────
// Strategy 1: Find explicit heading markers (=== CHAPTER: ===, numbered lines)
// Strategy 2 (fallback): Split at paragraph boundaries every ~SECTION_WORDS words

const SECTION_WORDS = 4000; // target words per section in fallback mode

function detectChapters(text: string): Array<{ title: string; startLine: number }> {
  const lines = text.split('\n');

  // Strategy 1a: PDF extraction markers
  const markerPattern = /^===\s*CHAPTER:\s*(.+?)\s*===$/i;

  // Strategy 1b: Numbered section headings (e.g. "1. Title", "Chapter 1", "1.Title")
  const numberedPattern = /^(?:chapter\s+\d+[:\s]|(\d{1,2})[.)]\s+\S)/i;

  const chapters: Array<{ title: string; startLine: number }> = [];

  // Skip front matter (first 5% of lines or 50 lines, whichever is smaller)
  const skip = Math.min(50, Math.floor(lines.length * 0.05));

  for (let i = skip; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const markerMatch = line.match(markerPattern);
    if (markerMatch) {
      chapters.push({ title: markerMatch[1], startLine: i });
      continue;
    }

    const numberedMatch = line.match(numberedPattern);
    if (numberedMatch && line.split(/\s+/).length <= 12) {
      chapters.push({ title: line.replace(/^(?:chapter\s+\d+[:\s.]|\d{1,2}[.)]\s*)/, '').trim() || line, startLine: i });
    }
  }

  if (chapters.length > 1) {
    // Sanity check: if all chapters are bunched within 200 lines of each other,
    // they're a table of contents, not real chapter starts — fall through to word-count split
    const span = chapters[chapters.length - 1].startLine - chapters[0].startLine;
    const avgGap = span / chapters.length;
    if (avgGap > 30) return chapters; // real chapters have meaningful content between them
  }

  // Strategy 2: fallback — split by word count at paragraph boundaries
  return splitByWordCount(lines, SECTION_WORDS);
}

function splitByWordCount(
  lines: string[],
  targetWords: number,
): Array<{ title: string; startLine: number }> {
  const sections: Array<{ title: string; startLine: number }> = [];
  let wordsSinceLastSplit = 0;
  let sectionIndex = 1;

  // Skip front matter
  const skip = Math.min(50, Math.floor(lines.length * 0.05));
  sections.push({ title: `Section 1`, startLine: skip });

  for (let i = skip; i < lines.length; i++) {
    const lineWords = lines[i].trim().split(/\s+/).filter(Boolean).length;
    wordsSinceLastSplit += lineWords;

    if (wordsSinceLastSplit >= targetWords) {
      // Find the next blank line (paragraph boundary) to split cleanly
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
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return Response.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });

    const formData = await req.formData().catch(() => null);
    if (!formData) return Response.json({ error: 'Invalid form data' }, { status: 400 });

    const file = formData.get('file') as File | null;
    if (!file) return Response.json({ error: 'No file provided' }, { status: 400 });

    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const buf = Buffer.from(await file.arrayBuffer());
    let extracted = '';

    if (ext === 'pdf') {
      extracted = await callClaudeWithDoc(
        apiKey, buf.toString('base64'),
        `Extract ALL text from this document exactly as written. Preserve:\n- Every paragraph (blank line between paragraphs)\n- All Gujarati Unicode text exactly\n- All numbers, dates, names, verses\n- Chapter headings (mark as "=== CHAPTER: <title> ===" on its own line)\n- Verse/kirtan lines on separate lines\n\nReturn ONLY the extracted text.`,
      );
    } else if (ext === 'docx') {
      extracted = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (ext === 'txt') {
      extracted = buf.toString('utf-8');
    } else {
      return Response.json({ error: `Unsupported file type: .${ext}` }, { status: 400 });
    }

    if (!extracted.trim()) {
      return Response.json({ error: 'No text could be extracted from this file.' }, { status: 422 });
    }

    const chapters = detectChapters(extracted);
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
