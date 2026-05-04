// Admin: per-job control actions for transliterationJobs.
// Mutates only `status`, `error`, `note`, `updatedAt` — fields the worker
// already understands. Worker only picks up status:'pending', so flipping
// to 'cancelled' or 'failed' takes the job out of its claim path.

import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAdminToken } from '@/lib/admin-auth';
import { adminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const admin = await verifyAdminToken(req);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await ctx.params;
  if (!id || id.length > 64) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const action = typeof body.action === 'string' ? body.action : null;
  if (action !== 'cancel' && action !== 'force-fail') {
    return NextResponse.json(
      { error: "action must be 'cancel' or 'force-fail'" },
      { status: 400 },
    );
  }

  try {
    const ref = adminDb.collection('transliterationJobs').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const current = snap.data() ?? {};
    const status: string = current.status ?? 'unknown';

    if (TERMINAL.has(status)) {
      return NextResponse.json(
        { error: `Job is already terminal (${status})` },
        { status: 409 },
      );
    }

    // 'cancel' for clean abort of pending. 'force-fail' for stuck running
    // jobs — the worker may still finish its in-flight Claude call but its
    // subsequent writes will be ignored client-side.
    const newStatus = action === 'cancel' ? 'cancelled' : 'failed';
    await ref.update({
      status: newStatus,
      error:
        action === 'force-fail'
          ? `Force-failed by admin <${admin.email}>`
          : FieldValue.delete(),
      note: `Status set to ${newStatus} by admin <${admin.email}>`,
      updatedAt: new Date().toISOString(),
    });
    return NextResponse.json({ id, status: newStatus });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.error('[admin/transliteration-jobs] PATCH error', message);
    return NextResponse.json({ error: 'Could not update job' }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const admin = await verifyAdminToken(req);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await ctx.params;
  if (!id || id.length > 64) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  try {
    // Cascade: pages subcollection first, then the parent.
    const pagesRef = adminDb.collection('transliterationJobs').doc(id).collection('pages');
    const pages = await pagesRef.limit(500).get();
    if (!pages.empty) {
      const batch = adminDb.batch();
      pages.docs.forEach((p) => batch.delete(p.ref));
      await batch.commit();
    }
    await adminDb.collection('transliterationJobs').doc(id).delete();
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.error('[admin/transliteration-jobs] DELETE error', message);
    return NextResponse.json({ error: 'Could not delete job' }, { status: 500 });
  }
}
