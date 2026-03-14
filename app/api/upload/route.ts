import https from 'node:https';
import { NextRequest } from 'next/server';

export const dynamic    = 'force-dynamic';
export const maxDuration = 60;

// ── Claude document extraction (native PDF support — handles Gujarati Unicode) ──

function callClaudeWithDoc(params: {
  apiKey: string;
  base64: string;
  mediaType: 'application/pdf';
  prompt: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: params.mediaType, data: params.base64 } },
          { type: 'text', text: params.prompt },
        ],
      }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key':           params.apiKey,
        'anthropic-version':   '2023-06-01',
        'anthropic-beta':      'pdfs-2024-09-25',
        'content-type':        'application/json',
        'content-length':      Buffer.byteLength(body),
      },
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

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });
  }

  const formData = await req.formData().catch(() => null);
  if (!formData) return Response.json({ error: 'Invalid form data' }, { status: 400 });

  const file = formData.get('file') as File | null;
  if (!file) return Response.json({ error: 'No file provided' }, { status: 400 });

  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const arrayBuf = await file.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  let extractedText = '';

  if (ext === 'pdf') {
    const base64 = buf.toString('base64');
    extractedText = await callClaudeWithDoc({
      apiKey,
      base64,
      mediaType: 'application/pdf',
      prompt: `Extract ALL text from this document exactly as written. Preserve:\n- Every paragraph (blank line between paragraphs)\n- All Gujarati Unicode text exactly\n- All numbers, dates, names, verses\n- Chapter headings and section breaks (mark with "=== CHAPTER: <title> ===" on its own line)\n- Verse/kirtan lines on separate lines\n\nReturn ONLY the extracted text. No commentary, no JSON, no formatting changes.`,
    });
  } else if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: buf });
    extractedText = result.value;
  } else if (ext === 'txt') {
    extractedText = buf.toString('utf-8');
  } else {
    return Response.json({ error: `Unsupported file type: .${ext}. Please upload PDF, DOCX, or TXT.` }, { status: 400 });
  }

  if (!extractedText.trim()) {
    return Response.json({ error: 'Could not extract text from file. The document may be image-only or empty.' }, { status: 422 });
  }

  // Detect chapters
  const lines = extractedText.split('\n');
  const chapterPattern = /^(===\s*CHAPTER:.*===|chapter\s+\d+|પ્રકરણ\s+\d+|\d+\.\s+[A-Z])/i;
  const chapters: Array<{ title: string; startLine: number }> = [];
  lines.forEach((line, i) => {
    if (chapterPattern.test(line.trim())) {
      chapters.push({ title: line.trim().replace(/^===\s*CHAPTER:\s*/, '').replace(/\s*===$/, ''), startLine: i });
    }
  });

  const wordCount = extractedText.trim().split(/\s+/).length;

  return Response.json({
    text:       extractedText,
    filename:   file.name,
    wordCount,
    chapters:   chapters.length > 0 ? chapters : null,
    isBookMode: wordCount > 3000,
  });
}
