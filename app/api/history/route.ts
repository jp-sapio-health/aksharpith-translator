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
      .where('uid', '==', authUser.uid)
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

export async function DELETE(req: NextRequest) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { id } = await req.json();
    if (!id || typeof id !== 'string') {
      return Response.json({ error: 'Missing translation id' }, { status: 400 });
    }

    const doc = await adminDb.collection('translations').doc(id).get();
    if (!doc.exists) return Response.json({ error: 'Not found' }, { status: 404 });
    if (doc.data()?.uid !== authUser.uid) return Response.json({ error: 'Forbidden' }, { status: 403 });

    await adminDb.collection('translations').doc(id).delete();
    return Response.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('History delete error:', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
