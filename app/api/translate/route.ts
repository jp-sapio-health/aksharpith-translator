import https from 'node:https';
import { NextRequest } from 'next/server';

export const dynamic    = 'force-dynamic';
export const maxDuration = 300;

// ─── Raw Anthropic API helper ───────────────────────────────────────────────

function callClaude(params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
  apiKey: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: params.model,
      max_tokens: params.max_tokens,
      system: params.system,
      messages: params.messages,
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': params.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Anthropic API ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            const data = JSON.parse(raw) as { content: Array<{ type: string; text: string }> };
            const text = data.content?.[0]?.type === 'text' ? data.content[0].text.trim() : '';
            resolve(text);
          } catch {
            reject(new Error(`Failed to parse response: ${raw.slice(0, 200)}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── System prompts ────────────────────────────────────────────────────────────

const TRANSLATION_SYSTEM = `\
You are an expert Gujarati-to-English translator specialising in BAPS Swaminarayan religious, \
biographical and historical texts published by Aksharpith. You work with scholarly precision \
and follow house style instructions exactly.

Core defaults (the user's style rules take precedence over these if they conflict):
- British English (Oxford/Hart's Rules) throughout
- Reverent, scholarly tone; fidelity to source meaning over literary fluency
- Diacritical marks (ā, ī, ū, etc.) ONLY in canonical verse quotations — never in running prose
- Curly double quotation marks (" ") for all speech and direct quotation
- Spaced en dash ( – ) for parenthetical clauses; not em dash
- Block-quote any passage over 40 words (indent, no quotation marks)
- Mandatory terms: paramhansa, avatari Purush, Shriji Maharaj, bawa, Swami (BAPS honorific)

Provide only the English translation. No preamble, no compliance notes, no section headers.`;

const REVIEWER_SYSTEM = `\
You are a meticulous translation reviewer for Aksharpith publications. Your role is to check \
a Gujarati-to-English translation against the provided house style rules, score its quality, \
flag specific issues with actionable wording, and provide a corrected version.

Return ONLY valid JSON — no markdown fences, no prose outside the JSON object.`;

const ASSEMBLER_SYSTEM = `\
You are a senior editor for Aksharpith publications. You receive a series of translated chunks \
from a Gujarati biographical/historical text and must assemble them into a single, coherent, \
publication-ready English document.

Rules:
- Remove all chunk markers, separators, and numbering
- Ensure smooth transitions between formerly separate chunks
- Maintain consistent British English, Oxford style, and reverent scholarly tone throughout
- Preserve all original paragraphs, verse quotations, and block quotations exactly
- Output only the final assembled document — no preamble or notes`;

// ─── Agent functions ───────────────────────────────────────────────────────────

async function chunkerAgent(apiKey: string, text: string): Promise<string[]> {
  const raw = await callClaude({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    apiKey,
    system: 'You are a text splitter. Split the provided Gujarati text at natural paragraph boundaries into chunks of at most 500 words each. Never break a paragraph mid-sentence. Return ONLY valid JSON with no markdown fences.',
    messages: [{
      role: 'user',
      content: `Split this Gujarati text into chunks of at most 500 words, \
splitting ONLY at natural paragraph boundaries (blank lines between paragraphs). \
Return JSON exactly as: {"chunks": ["chunk1 text", "chunk2 text", ...]}\n\nTEXT:\n${text}`,
    }],
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [text];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const chunks = Array.isArray(parsed.chunks) ? parsed.chunks.filter((c: unknown) => typeof c === 'string' && c.trim()) : [];
    return chunks.length > 0 ? chunks : [text];
  } catch {
    return [text];
  }
}

async function translatorAgent(apiKey: string, chunk: string, styleContext: string): Promise<string> {
  return callClaude({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    apiKey,
    system: TRANSLATION_SYSTEM,
    messages: [{
      role: 'user',
      content: `STYLE RULES (follow strictly):\n${styleContext}\n\n${'─'.repeat(60)}\n\nTranslate the following Gujarati text to English. Provide only the translation.\n\nGUJARATI:\n${chunk}`,
    }],
  });
}

interface ReviewResult {
  score: number;
  issues: string[];
  revised: string;
}

async function reviewerAgent(
  apiKey: string,
  original: string,
  translation: string,
  styleContext: string,
): Promise<ReviewResult> {
  const raw = await callClaude({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    apiKey,
    system: REVIEWER_SYSTEM,
    messages: [{
      role: 'user',
      content: `STYLE RULES:\n${styleContext}\n\n${'─'.repeat(60)}\n\nORIGINAL (Gujarati):\n${original}\n\nTRANSLATION TO REVIEW:\n${translation}\n\nReturn JSON:\n{"score": <integer 0-100>, "issues": ["concise issue description", ...], "revised": "<corrected translation, or identical if no changes needed>"}`,
    }],
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { score: 70, issues: [], revised: translation };

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score:   typeof parsed.score   === 'number' ? Math.max(0, Math.min(100, parsed.score)) : 70,
      issues:  Array.isArray(parsed.issues)        ? parsed.issues.filter((s: unknown) => typeof s === 'string') : [],
      revised: typeof parsed.revised === 'string' && parsed.revised.trim() ? parsed.revised.trim() : translation,
    };
  } catch {
    return { score: 70, issues: [], revised: translation };
  }
}

async function assemblerAgent(apiKey: string, revisedChunks: string[]): Promise<string> {
  const combined = revisedChunks.join('\n\n');
  return callClaude({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    apiKey,
    system: ASSEMBLER_SYSTEM,
    messages: [{
      role: 'user',
      content: `Assemble the following translated chunks into a single, coherent document. \
Ensure smooth transitions and unified tone. Output only the final document.\n\n${combined}`,
    }],
  });
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { text, styleContext } = body as { text?: string; styleContext?: string };

  if (!text?.trim()) {
    return new Response(JSON.stringify({ error: 'No text provided' }), { status: 400 });
  }

  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount > 8000) {
    return new Response(JSON.stringify({ error: `Input too long (${wordCount} words). Please keep under 8,000 words.` }), { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // ── Chunker ──────────────────────────────────────────────────
        send({ stage: 'chunker', status: 'running' });
        const chunks = await chunkerAgent(apiKey, text);
        send({ stage: 'chunker', status: 'done', count: chunks.length, chunks });

        // ── Translator ───────────────────────────────────────────────
        send({ stage: 'translator', status: 'running' });
        const translations: string[] = [];

        for (let i = 0; i < chunks.length; i++) {
          const translation = await translatorAgent(apiKey, chunks[i], styleContext ?? '');
          translations.push(translation);
          send({
            stage: 'translator', status: 'progress',
            current: i + 1, total: chunks.length,
            index: i, translation,
          });
        }
        send({ stage: 'translator', status: 'done' });

        // ── Reviewer ─────────────────────────────────────────────────
        send({ stage: 'reviewer', status: 'running' });
        const reviews: ReviewResult[] = [];

        for (let i = 0; i < chunks.length; i++) {
          const review = await reviewerAgent(apiKey, chunks[i], translations[i], styleContext ?? '');
          reviews.push(review);
          send({
            stage: 'reviewer', status: 'progress',
            chunk: i + 1, index: i,
            score: review.score, issues: review.issues, revised: review.revised,
          });
        }

        const avgScore = reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length;
        send({ stage: 'reviewer', status: 'done', avgScore });

        // ── Assembler ────────────────────────────────────────────────
        send({ stage: 'assembler', status: 'running' });
        const revisedTexts = reviews.map(r => r.revised);
        const assembled    = await assemblerAgent(apiKey, revisedTexts);
        send({ stage: 'assembler', status: 'done', output: assembled });

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        console.error('Pipeline error:', msg, e);
        send({ error: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':       'text/event-stream',
      'Cache-Control':      'no-cache, no-transform',
      'Connection':         'keep-alive',
      'X-Accel-Buffering':  'no',
    },
  });
}
