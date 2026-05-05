// Admin: bulk actions across the legacy `jobs` (paste-text) collection.
// Same contract as transliteration-jobs/bulk — only mutates status /
// error / note / completedAt. Worker still only claims status:'pending'
// so flipping to cancelled / failed takes them out of the claim path.

import { NextResponse } from 'next/server';
import { verifyAdminToken } from '@/lib/admin-auth';
import { adminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

type Action =
  | 'cancel-pending'
  | 'force-fail-stuck'
  | 'delete-failed'
  | 'delete-cancelled';

export async function POST(req: Request) {
  const admin = await verifyAdminToken(req);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const action = typeof body.action === 'string' ? (body.action as Action) : null;
  if (!action) return NextResponse.json({ error: 'action required' }, { status: 400 });

  try {
    let affected = 0;
    const now = new Date().toISOString();

    if (action === 'cancel-pending') {
      const snap = await adminDb.collection('jobs').where('status', '==', 'pending').get();
      const batch = adminDb.batch();
      for (const d of snap.docs) {
        batch.update(d.ref, {
          status: 'cancelled',
          note: `Bulk cancel by admin <${admin.email}>`,
          completedAt: now,
        });
        affected++;
      }
      if (affected > 0) await batch.commit();
    } else if (action === 'force-fail-stuck') {
      const snap = await adminDb.collection('jobs').where('status', '==', 'running').get();
      const batch = adminDb.batch();
      for (const d of snap.docs) {
        batch.update(d.ref, {
          status: 'failed',
          error: `Force-failed (bulk) by admin <${admin.email}>`,
          note: 'Bulk force-fail from running',
          completedAt: now,
        });
        affected++;
      }
      if (affected > 0) await batch.commit();
    } else if (action === 'delete-failed' || action === 'delete-cancelled') {
      const target = action === 'delete-failed' ? 'failed' : 'cancelled';
      const snap = await adminDb.collection('jobs').where('status', '==', target).get();
      for (const d of snap.docs) {
        await d.ref.delete();
        affected++;
      }
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    return NextResponse.json({ ok: true, affected, action });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.error('[admin/jobs/bulk] error', message);
    return NextResponse.json({ error: 'Bulk action failed' }, { status: 500 });
  }
}
