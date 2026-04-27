import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';
import { checkRateLimit } from '../../../lib/rate-limit';

export const dynamic = 'force-dynamic';

const MAX_CHAPTERS = 100;
const MAX_WORDS_PER_CHAPTER = 50_000;

// Server-side book enqueue. Client uploads pre-extracted chapters; we create
// one Firestore job per chapter atomically. The worker picks them up in
// queue order (status=pending, oldest first). No client-side for-loop, so
// closing the browser tab no longer aborts the book.
export async function POST(req: NextRequest) {
  try {
    const authUser = await verifyAuthToken(req);
    if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const rl = checkRateLimit(`translate-book:${authUser.uid}`);
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

    const { bookId, bookTitle, chapters } = body as {
      bookId?: string;
      bookTitle?: string;
      chapters?: Array<{ chapterIndex?: number; chapterTitle?: string; text?: string }>;
    };

    if (!bookId || typeof bookId !== 'string') {
      return Response.json({ error: 'bookId required (string)' }, { status: 400 });
    }
    if (!Array.isArray(chapters) || chapters.length === 0) {
      return Response.json({ error: 'chapters required (non-empty array)' }, { status: 400 });
    }
    if (chapters.length > MAX_CHAPTERS) {
      return Response.json(
        { error: `Too many chapters (${chapters.length}). Maximum is ${MAX_CHAPTERS}.` },
        { status: 400 }
      );
    }

    const totalChapters = chapters.length;
    const validated: Array<{
      chapterIndex: number;
      chapterTitle: string;
      text: string;
      wordCount: number;
    }> = [];

    for (const ch of chapters) {
      if (typeof ch.chapterIndex !== 'number' ||
          typeof ch.chapterTitle !== 'string' ||
          typeof ch.text !== 'string') {
        return Response.json(
          { error: 'Invalid chapter shape: each chapter needs chapterIndex (number), chapterTitle (string), text (string)' },
          { status: 400 }
        );
      }
      const text = ch.text.trim();
      if (!text) continue; // skip empty chapters silently — they get no job

      const wordCount = text.split(/\s+/).filter(Boolean).length;
      if (wordCount > MAX_WORDS_PER_CHAPTER) {
        return Response.json(
          {
            error:
              `Chapter ${ch.chapterIndex + 1} (${ch.chapterTitle}) is too long: ` +
              `${wordCount.toLocaleString()} words. Maximum is ${MAX_WORDS_PER_CHAPTER.toLocaleString()}.`,
          },
          { status: 400 }
        );
      }
      validated.push({
        chapterIndex: ch.chapterIndex,
        chapterTitle: ch.chapterTitle,
        text,
        wordCount,
      });
    }

    if (validated.length === 0) {
      return Response.json({ error: 'No non-empty chapters provided' }, { status: 400 });
    }

    const batch = adminDb.batch();
    const chapterJobs: Array<{ chapterIndex: number; jobId: string }> = [];
    const now = new Date().toISOString();

    for (const ch of validated) {
      const jobRef = adminDb.collection('jobs').doc();
      batch.set(jobRef, {
        status: 'pending',
        mode: 'local' as const,
        uid: authUser.uid,
        email: authUser.email ?? '',
        input: {
          text: ch.text,
          wordCount: ch.wordCount,
          chapterTitle: ch.chapterTitle,
          chapterIndex: ch.chapterIndex,
          totalChapters,
          bookId,
          bookTitle: bookTitle ?? null,
        },
        createdAt: now,
        startedAt: null,
        completedAt: null,
        error: null,
        progress: { currentStage: 'pending', stages: {}, chunks: [] },
        result: null,
      });
      chapterJobs.push({ chapterIndex: ch.chapterIndex, jobId: jobRef.id });
    }

    await batch.commit();

    return Response.json({ bookId, bookTitle: bookTitle ?? null, totalChapters, chapterJobs });
  } catch (err: unknown) {
    console.error('Translate-book POST error:', err);
    const isDev = process.env.NODE_ENV !== 'production';
    return Response.json(
      isDev
        ? { error: err instanceof Error ? err.message : 'Internal server error', stack: err instanceof Error ? err.stack : undefined }
        : { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
