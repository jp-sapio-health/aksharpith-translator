import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../../lib/verify-auth';
import { adminDb } from '../../../../lib/firebase-admin';
import type { ChunkProgress } from '../../../../lib/job-types';

export const dynamic = 'force-dynamic';

/**
 * User-facing job poller. Strips reviewer-derived fields (score, certifiable,
 * categories, deductions, reviewerSummary) from the response — those are
 * admin-only and only available via /api/admin/translate/[jobId]. Translator
 * self-flags ARE surfaced here, since they help the user understand uncertainty.
 */

interface FirestoreChunkProgress extends ChunkProgress {
  // Server-side may carry reviewer-derived fields when telemetry is on; we
  // strip them at the boundary.
  scoreHistory?: number[];
}

interface FirestoreJobProgress {
  currentStage: string;
  commentary?: string;
  stages: Record<string, unknown>;
  chunks?: FirestoreChunkProgress[];
}

interface FirestoreJobResult {
  output: string;
  wordCount: number;
  totalFixes: number;
  corrections: Array<{ from: string; to: string; rule: string; count: number }>;
  flagsCount?: number;
  translationId: string;
  // Admin-only fields stripped before returning:
  avgScore?: number;
  reviewerSummary?: unknown;
}

function stripChunkForUser(chunk: FirestoreChunkProgress): ChunkProgress {
  return {
    index: chunk.index,
    original: chunk.original,
    translation: chunk.translation,
    flags: chunk.flags ?? [],
  };
}

function stripStagesForUser(stages: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stages)) {
    if (key === 'reviewer') continue; // admin only
    out[key] = value;
  }
  return out;
}

function stripProgressForUser(progress: FirestoreJobProgress | null | undefined) {
  if (!progress) return null;
  return {
    currentStage: progress.currentStage,
    commentary: progress.commentary,
    stages: stripStagesForUser(progress.stages ?? {}),
    chunks: (progress.chunks ?? []).map(stripChunkForUser),
  };
}

function stripResultForUser(result: FirestoreJobResult | null | undefined) {
  if (!result) return null;
  return {
    output: result.output,
    wordCount: result.wordCount,
    totalFixes: result.totalFixes,
    corrections: result.corrections,
    flagsCount: result.flagsCount ?? 0,
    translationId: result.translationId,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { jobId } = await params;
  const doc = await adminDb.collection('jobs').doc(jobId).get();

  if (!doc.exists) return Response.json({ error: 'Job not found' }, { status: 404 });

  const data = doc.data()!;

  // Only the job owner can poll
  if (data.uid !== authUser.uid) return Response.json({ error: 'Forbidden' }, { status: 403 });

  return Response.json({
    jobId,
    status: data.status,
    progress: stripProgressForUser(data.progress as FirestoreJobProgress | null),
    result: stripResultForUser(data.result as FirestoreJobResult | null),
    error: data.error ?? null,
    createdAt: data.createdAt,
  });
}
