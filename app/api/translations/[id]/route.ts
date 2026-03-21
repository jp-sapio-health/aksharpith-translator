import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../../lib/verify-auth';
import { adminDb } from '../../../../lib/firebase-admin';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const doc = await adminDb.collection('translations').doc(id).get();
  if (!doc.exists) return Response.json({ error: 'Not found' }, { status: 404 });

  return Response.json({ id: doc.id, ...doc.data() });
}
