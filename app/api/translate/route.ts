import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';
import { checkRateLimit } from '../../../lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const authUser = await verifyAuthToken(req);
    if (!authUser) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rl = checkRateLimit(`translate:${authUser.uid}`);
    if (!rl.allowed) {
      return Response.json(
        { error: 'Rate limit exceeded', retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { text, chapterTitle, bookId, chapterIndex, totalChapters, bookTitle } = body as {
      text?: string; chapterTitle?: string;
      bookId?: string; chapterIndex?: number; totalChapters?: number; bookTitle?: string;
    };

    if (!text || !text.trim()) {
      return Response.json({ error: 'No text provided' }, { status: 400 });
    }

    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount === 0) {
      return Response.json({ error: 'No text provided' }, { status: 400 });
    }
    if (wordCount > 50000) {
      return Response.json({ error: `Section too long (${wordCount.toLocaleString()} words). Maximum is 50,000.` }, { status: 400 });
    }

    // All processing runs locally — no Vercel timeout limits
    const mode = 'local' as const;

    const jobRef = await adminDb.collection('jobs').add({
      status: 'pending',
      mode,
      uid: authUser.uid,
      email: authUser.email ?? '',
      input: { text, wordCount, chapterTitle: chapterTitle ?? null, bookId: bookId ?? null, bookTitle: bookTitle ?? null, chapterIndex: chapterIndex ?? null, totalChapters: totalChapters ?? null },
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: null,
      progress: { currentStage: 'pending', stages: {}, chunks: [] },
      result: null,
    });

    return Response.json({ jobId: jobRef.id, mode });
  } catch (err: unknown) {
    console.error('Translate POST error:', err);
    const isDev = process.env.NODE_ENV !== 'production';
    return Response.json(
      isDev
        ? { error: err instanceof Error ? err.message : 'Internal server error', stack: err instanceof Error ? err.stack : undefined }
        : { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
