import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthToken } from '../../../../lib/verify-auth';
import { adminDb } from '../../../../lib/firebase-admin';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ translationId: string }> },
) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { translationId } = await params;
  const sectionIndex = req.nextUrl.searchParams.get('sectionIndex');

  let query = adminDb
    .collection('translations')
    .doc(translationId)
    .collection('reviews')
    .orderBy('createdAt', 'asc') as FirebaseFirestore.Query;

  if (sectionIndex !== null && sectionIndex !== undefined) {
    query = query.where('sectionIndex', '==', parseInt(sectionIndex, 10));
  }

  const snapshot = await query.get();
  const comments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // Group by sectionIndex
  const grouped: Record<number, typeof comments> = {};
  for (const c of comments) {
    const idx = (c as Record<string, unknown>).sectionIndex as number;
    if (!grouped[idx]) grouped[idx] = [];
    grouped[idx].push(c);
  }

  return NextResponse.json({ comments, grouped });
}
