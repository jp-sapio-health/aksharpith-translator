import { NextRequest } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';
import { runPipeline } from '../../../lib/pipeline';
import type { JobDocument, JobProgressUpdate } from '../../../lib/job-types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
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

  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    return Response.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });
  }

  // Create job document in Firestore
  const jobData: JobDocument = {
    status: 'pending',
    uid: authUser.uid,
    email: authUser.email ?? '',
    input: { text, wordCount, chapterTitle, bookId, bookTitle, chapterIndex, totalChapters },
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    error: null,
    progress: null,
    result: null,
  };

  const jobRef = await adminDb.collection('jobs').add(jobData);
  const jobId = jobRef.id;

  // Run pipeline in background — waitUntil keeps the function alive after response
  if (process.env.FIREBASE_FUNCTIONS !== 'true') {
    const reportProgress = async (update: JobProgressUpdate) => {
      const firestoreUpdate: Record<string, unknown> = {};
      if (update.status) firestoreUpdate.status = update.status;
      if (update.startedAt) firestoreUpdate.startedAt = update.startedAt;
      if (update.completedAt) firestoreUpdate.completedAt = update.completedAt;
      if (update.error) firestoreUpdate.error = update.error;
      if (update.result) firestoreUpdate.result = update.result;
      if (update.progress) {
        if (update.progress.currentStage) firestoreUpdate['progress.currentStage'] = update.progress.currentStage;
        if (update.progress.chunks) firestoreUpdate['progress.chunks'] = update.progress.chunks;
        if (update.progress.stages) {
          for (const [stage, data] of Object.entries(update.progress.stages)) {
            for (const [key, val] of Object.entries(data as unknown as Record<string, unknown>)) {
              firestoreUpdate[`progress.stages.${stage}.${key}`] = val;
            }
          }
        }
      }
      await adminDb.collection('jobs').doc(jobId).update(firestoreUpdate);
    };

    waitUntil(
      runPipeline(
        { text, wordCount, chapterTitle, bookId, bookTitle, chapterIndex, totalChapters },
        { uid: authUser.uid, email: authUser.email ?? '' },
        reportProgress,
        adminDb,
      ).catch(async (err) => {
        console.error('Pipeline error:', err);
        try {
          await adminDb.collection('jobs').doc(jobId).update({
            status: 'failed',
            error: err instanceof Error ? err.message : 'Unknown error',
            completedAt: new Date().toISOString(),
          });
        } catch { /* ignore */ }
      })
    );
  }

  return Response.json({ jobId });
}
