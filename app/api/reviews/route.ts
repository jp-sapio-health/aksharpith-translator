import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';

export async function POST(req: NextRequest) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.translationId !== 'string' || typeof body.comment !== 'string' || typeof body.sectionIndex !== 'number') {
    return NextResponse.json({ error: 'Missing translationId, sectionIndex, or comment' }, { status: 400 });
  }

  const { translationId, sectionIndex, comment } = body;
  if (!comment.trim()) return NextResponse.json({ error: 'Comment cannot be empty' }, { status: 400 });

  const reviewData = {
    uid: authUser.uid,
    email: authUser.email ?? '',
    displayName: body.displayName ?? authUser.email?.split('@')[0] ?? 'Anonymous',
    comment: comment.trim(),
    sectionIndex,
    createdAt: new Date().toISOString(),
  };

  const docRef = await adminDb
    .collection('translations')
    .doc(translationId)
    .collection('reviews')
    .add(reviewData);

  return NextResponse.json({
    comment: { id: docRef.id, ...reviewData },
  });
}

export async function GET(req: NextRequest) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const translationId = req.nextUrl.searchParams.get('translationId');
  if (!translationId) return NextResponse.json({ error: 'Missing translationId' }, { status: 400 });

  const snapshot = await adminDb
    .collection('translations')
    .doc(translationId)
    .collection('reviews')
    .orderBy('createdAt', 'asc')
    .get();

  const comments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  return NextResponse.json({ comments });
}
