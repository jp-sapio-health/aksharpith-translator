import https from 'node:https';
import mammoth from 'mammoth';
import { NextRequest } from 'next/server';

export const dynamic    = 'force-dynamic';
export const maxDuration = 60;

// ── Claude PDF extraction (native vision — handles Gujarati Unicode) ──────────

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
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':          apiKey,
        'anthropic-version':  '2023-06-01',
        'anthropic-beta':     'pdfs-2024-09-25',
        'content-type':       'application/json',
        'content-length':     Buffer.byteLength(body),
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
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return Response.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });

    const formData = await req.formData().catch(() => null);
    if (!formData) return Response.json({ error: 'Invalid form data' }, { status: 400 });

    const file = formData.get('file') as File | null;
    if (!file) return Response.json({ error: 'No file provided' }, { status: 400 });

    const ext    = file.name.split('.').pop()?.toLowerCase() ?? '';
    const buf    = Buffer.from(await file.arrayBuffer());
    let extracted = '';

    if (ext === 'pdf') {
      extracted = await callClaudeWithDoc(
        apiKey, buf.toString('base64'),
        `Extract ALL text from this document exactly as written. Preserve:\n- Every paragraph (blank line between paragraphs)\n- All Gujarati Unicode text exactly\n- All numbers, dates, names, verses\n- Chapter headings (mark as "=== CHAPTER: <title> ===" on its own line)\n- Verse/kirtan lines on separate lines\n\nReturn ONLY the extracted text. No commentary.`,
      );
    } else if (ext === 'docx') {
      const result = await mammoth.extractRawText({ buffer: buf });
      extracted = result.value;
    } else if (ext === 'txt') {
      extracted = buf.toString('utf-8');
    } else {
      return Response.json({ error: `Unsupported file type: .${ext}. Please upload PDF, DOCX, or TXT.` }, { status: 400 });
    }

    if (!extracted.trim()) {
      return Response.json({ error: 'No text could be extracted. The document may be image-based or empty.' }, { status: 422 });
    }

    // Chapter detection
    const lines = extracted.split('\n');
    const chapterRe = /^(===\s*CHAPTER:.*===|chapter\s+\d+|પ્રકરણ\s*\d+|\d+\.\s+\S)/i;
    const chapters: Array<{ title: string; startLine: number }> = [];
    lines.forEach((line, i) => {
      if (chapterRe.test(line.trim())) {
        chapters.push({
          title:     line.trim().replace(/^===\s*CHAPTER:\s*/, '').replace(/\s*===$/, ''),
          startLine: i,
        });
      }
    });

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
