import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const snapshot = await adminDb
      .collection('translations')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    const translations = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    return Response.json({ translations });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('History fetch error:', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
