import { NextRequest } from 'next/server';
import { verifyAdminToken } from '../../../../../lib/admin-auth';
import { adminDb } from '../../../../../lib/firebase-admin';

export const dynamic = 'force-dynamic';

/**
 * Admin-only job poller. Returns the unfiltered job document, including
 * reviewer-derived telemetry (score, categories, deductions) and the
 * adminTelemetry block. Guarded by verifyAdminToken — both Firebase custom
 * claim and email allowlist must agree.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const admin = await verifyAdminToken(req);
  if (!admin) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { jobId } = await params;
  const jobDoc = await adminDb.collection('jobs').doc(jobId).get();
  if (!jobDoc.exists) return Response.json({ error: 'Job not found' }, { status: 404 });
  const job = jobDoc.data()!;

  // If a translation document was created, fetch it too for the per-chunk
  // adminTelemetry block.
  let translation: FirebaseFirestore.DocumentData | null = null;
  const translationId: string | undefined = job.result?.translationId;
  if (translationId) {
    const tDoc = await adminDb.collection('translations').doc(translationId).get();
    if (tDoc.exists) translation = tDoc.data() ?? null;
  }

  return Response.json({
    jobId,
    status: job.status,
    progress: job.progress ?? null,
    result: job.result ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt,
    translation: translation
      ? {
          id: translationId,
          chunkData: translation.chunkData ?? [],
          flagsCount: translation.flagsCount ?? 0,
          adminTelemetry: translation.adminTelemetry ?? null,
        }
      : null,
  });
}
