import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../../lib/verify-auth';
import { adminDb } from '../../../../lib/firebase-admin';

export const dynamic = 'force-dynamic';

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
    progress: data.progress ?? null,
    result: data.result ?? null,
    error: data.error ?? null,
    createdAt: data.createdAt,
  });
}
