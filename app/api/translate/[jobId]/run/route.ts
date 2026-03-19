import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../../../lib/verify-auth';
import { adminDb } from '../../../../../lib/firebase-admin';
import { runPipeline } from '../../../../../lib/pipeline';
import type { JobProgressUpdate } from '../../../../../lib/job-types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// This endpoint BLOCKS while the pipeline runs (up to 300s).
// The client calls it fire-and-forget — polling picks up progress via Firestore.

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { jobId } = await params;
  const doc = await adminDb.collection('jobs').doc(jobId).get();
  if (!doc.exists) return Response.json({ error: 'Job not found' }, { status: 404 });

  const data = doc.data()!;
  if (data.uid !== authUser.uid) return Response.json({ error: 'Forbidden' }, { status: 403 });
  if (data.status !== 'pending') return Response.json({ error: 'Job already started' }, { status: 409 });

  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    return Response.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });
  }

  const { input } = data;

  const reportProgress = async (update: JobProgressUpdate) => {
    const mergeDoc: Record<string, unknown> = {};
    if (update.status) mergeDoc.status = update.status;
    if (update.startedAt) mergeDoc.startedAt = update.startedAt;
    if (update.completedAt) mergeDoc.completedAt = update.completedAt;
    if (update.error) mergeDoc.error = update.error;
    if (update.result) mergeDoc.result = update.result;
    if (update.progress) {
      const existing = (await adminDb.collection('jobs').doc(jobId).get()).data()?.progress ?? { currentStage: '', stages: {}, chunks: [] };
      const mergedStages: Record<string, unknown> = { ...existing.stages };
      if (update.progress.stages) {
        for (const [stage, stageData] of Object.entries(update.progress.stages)) {
          mergedStages[stage] = { ...(mergedStages[stage] as Record<string, unknown> ?? {}), ...(stageData as unknown as Record<string, unknown>) };
        }
      }
      const merged: Record<string, unknown> = {
        currentStage: update.progress.currentStage ?? existing.currentStage,
        stages: mergedStages,
        chunks: update.progress.chunks ?? existing.chunks,
      };
      if ((update.progress as Record<string, unknown>).commentary) {
        merged.commentary = (update.progress as Record<string, unknown>).commentary;
      }
      mergeDoc.progress = merged;
    }
    await adminDb.collection('jobs').doc(jobId).set(mergeDoc, { merge: true });
  };

  try {
    await runPipeline(
      input,
      { uid: authUser.uid, email: authUser.email ?? '' },
      reportProgress,
      adminDb,
    );
    return Response.json({ ok: true });
  } catch (err) {
    console.error('Pipeline error:', err);
    await adminDb.collection('jobs').doc(jobId).set({
      status: 'failed',
      error: err instanceof Error ? err.message : 'Unknown error',
      completedAt: new Date().toISOString(),
    }, { merge: true });
    return Response.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
