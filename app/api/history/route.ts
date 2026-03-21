import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export async function GET(req: NextRequest) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const cursor = req.nextUrl.searchParams.get('cursor');
    const limit = Math.min(
      Number(req.nextUrl.searchParams.get('limit')) || PAGE_SIZE,
      50,
    );

    let query = adminDb
      .collection('translations')
      .orderBy('createdAt', 'desc')
      .limit(limit + 1); // fetch one extra to detect next page

    if (cursor) {
      const cursorDoc = await adminDb.collection('translations').doc(cursor).get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    const snapshot = await query.get();
    const docs = snapshot.docs;
    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    const translations = page.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    return Response.json({ translations, nextCursor });
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
