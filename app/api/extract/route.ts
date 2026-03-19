import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return Response.json({ error: 'Missing extraction id' }, { status: 400 });

  const doc = await adminDb.collection('extractions').doc(id).get();
  if (!doc.exists) return Response.json({ error: 'Not found' }, { status: 404 });

  const data = doc.data()!;
  return Response.json({
    status: data.status,
    text: data.text ?? null,
    filename: data.filename ?? null,
    wordCount: data.wordCount ?? null,
    chapters: data.chapters ?? null,
    progress: data.progress ?? null,
    error: data.error ?? null,
  });
}
