import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';
import type { JobDocument } from '../../../lib/job-types';

export const dynamic = 'force-dynamic';

// POST creates a job document in Firestore and returns { jobId }.
// The client then:
//   1. Starts polling GET /api/translate/{jobId}
//   2. Fires POST /api/translate/{jobId}/run (fire-and-forget — this blocks while pipeline runs)
// Polling picks up progress from Firestore as the pipeline executes.

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
  return Response.json({ jobId: jobRef.id });
}
