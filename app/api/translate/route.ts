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
    progress: { currentStage: 'pending', stages: {}, chunks: [] },
    result: null,
  };

  const jobRef = await adminDb.collection('jobs').add(jobData);
  const jobId = jobRef.id;

  // Run pipeline in background — waitUntil keeps the function alive after response
  if (process.env.FIREBASE_FUNCTIONS !== 'true') {
    const reportProgress = async (update: JobProgressUpdate) => {
      const doc: Record<string, unknown> = {};
      if (update.status) doc.status = update.status;
      if (update.startedAt) doc.startedAt = update.startedAt;
      if (update.completedAt) doc.completedAt = update.completedAt;
      if (update.error) doc.error = update.error;
      if (update.result) doc.result = update.result;
      if (update.progress) {
        // Build a full progress object to merge
        const existingDoc = await adminDb.collection('jobs').doc(jobId).get();
        const existing = existingDoc.data()?.progress ?? { currentStage: '', stages: {}, chunks: [] };
        const merged = {
          currentStage: update.progress.currentStage ?? existing.currentStage,
          stages: { ...existing.stages },
          chunks: update.progress.chunks ?? existing.chunks,
        };
        // Merge stage updates
        if (update.progress.stages) {
          for (const [stage, data] of Object.entries(update.progress.stages)) {
            merged.stages[stage] = { ...(merged.stages[stage] ?? {}), ...(data as unknown as Record<string, unknown>) };
          }
        }
        doc.progress = merged;
      }
      await adminDb.collection('jobs').doc(jobId).set(doc, { merge: true });
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
