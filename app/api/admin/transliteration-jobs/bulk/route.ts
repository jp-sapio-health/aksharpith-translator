// Admin: bulk actions across the transliterationJobs collection.
// Single endpoint takes { action } and applies to every doc in the
// matching status set. Mutates only fields the worker already
// understands (status / error / note / updatedAt) — same contract as
// the per-job route.

import { NextResponse } from 'next/server';
import { verifyAdminToken } from '@/lib/admin-auth';
import { adminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

type Action =
  | 'cancel-pending'
  | 'force-fail-stuck'
  | 'delete-failed'
  | 'delete-cancelled';

const IN_FLIGHT = new Set([
  'ocr_running',
  'assembling',
  'transliterating',
]);

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
  if (!action) {
    return NextResponse.json({ error: 'action required' }, { status: 400 });
  }

  try {
    let affected = 0;
    const now = new Date().toISOString();

    if (action === 'cancel-pending') {
      const snap = await adminDb
        .collection('transliterationJobs')
        .where('status', '==', 'pending')
        .get();
      const batch = adminDb.batch();
      for (const d of snap.docs) {
        batch.update(d.ref, {
          status: 'cancelled',
          note: `Bulk cancel by admin <${admin.email}>`,
          updatedAt: now,
        });
        affected++;
      }
      if (affected > 0) await batch.commit();
    } else if (action === 'force-fail-stuck') {
      // Force-fail every job currently in an in-flight status. The worker
      // may still emit completion writes for any of these; those writes
      // would silently overwrite, but in practice if you're force-failing
      // you've already determined the worker is stuck.
      for (const status of IN_FLIGHT) {
        const snap = await adminDb
          .collection('transliterationJobs')
          .where('status', '==', status)
          .get();
        const batch = adminDb.batch();
        for (const d of snap.docs) {
          batch.update(d.ref, {
            status: 'failed',
            error: `Force-failed (bulk) by admin <${admin.email}>`,
            note: `Bulk force-fail from ${status}`,
            updatedAt: now,
          });
          affected++;
        }
        if (snap.docs.length > 0) await batch.commit();
      }
    } else if (action === 'delete-failed' || action === 'delete-cancelled') {
      const targetStatus = action === 'delete-failed' ? 'failed' : 'cancelled';
      const snap = await adminDb
        .collection('transliterationJobs')
        .where('status', '==', targetStatus)
        .get();
      // Pages subcollection cleanup runs in series — bulk deletes can be
      // large and we don't want to drown Firestore in a single batch.
      for (const d of snap.docs) {
        const pages = await d.ref.collection('pages').limit(500).get();
        if (!pages.empty) {
          const pb = adminDb.batch();
          pages.docs.forEach((p) => pb.delete(p.ref));
          await pb.commit();
        }
        await d.ref.delete();
        affected++;
      }
    } else {
      return NextResponse.json(
        { error: `Unknown action: ${action}` },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true, affected, action });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.error('[admin/transliteration-jobs/bulk] error', message);
    return NextResponse.json(
      { error: 'Bulk action failed' },
      { status: 500 },
    );
  }
}
