// Admin: retry a single failed page within a transliteration job.
// Flips the page status from 'ocr_failed' back to 'pending' so the
// worker re-claims it. Also nudges the parent job back to
// 'ocr_running' if it had drifted to a terminal state — the worker
// only scans parents whose status is 'pending' or 'ocr_running'
// (scripts/local-worker.mjs:885,1022), so a failed parent would
// otherwise leave the retried page un-picked-up.

import { NextResponse } from 'next/server';
import { verifyAdminToken } from '@/lib/admin-auth';
import { adminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; pageNum: string }> },
) {
  const admin = await verifyAdminToken(req);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id, pageNum } = await ctx.params;
  if (!id || id.length > 64) {
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
  }
  const pageNumInt = parseInt(pageNum, 10);
  if (!Number.isFinite(pageNumInt) || pageNumInt < 1 || pageNumInt > 9999) {
    return NextResponse.json({ error: 'Invalid pageNum' }, { status: 400 });
  }

  try {
    const jobRef = adminDb.collection('transliterationJobs').doc(id);
    const pageRef = jobRef
      .collection('pages')
      .doc(String(pageNumInt).padStart(4, '0'));

    const [jobSnap, pageSnap] = await Promise.all([jobRef.get(), pageRef.get()]);
    if (!jobSnap.exists) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    if (!pageSnap.exists) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    const now = new Date().toISOString();
    const pageData = pageSnap.data() ?? {};
    // Allow retry on any non-success page status — failed is the common
    // case but pending / running pages can also be 'kicked' here.
    if (pageData.status === 'ocr_done') {
      return NextResponse.json(
        { error: 'Page already completed; no retry needed' },
        { status: 409 },
      );
    }

    const batch = adminDb.batch();
    batch.update(pageRef, {
      status: 'pending',
      attempts: (pageData.attempts ?? 0) + 0, // worker increments on claim
      error: null,
      retryRequestedAt: now,
      retryRequestedBy: admin.email,
    });

    // If the parent is in a terminal state, the worker won't poll its
    // pages. Flip back to ocr_running so the retry is actually picked up.
    const jobData = jobSnap.data() ?? {};
    const parentStatus = jobData.status;
    if (
      parentStatus === 'failed' ||
      parentStatus === 'done' ||
      parentStatus === 'cancelled'
    ) {
      batch.update(jobRef, {
        status: 'ocr_running',
        error: null,
        note: `Re-opened by admin <${admin.email}> for page ${pageNumInt} retry`,
        completedAt: null,
      });
    }

    await batch.commit();
    return NextResponse.json({ ok: true, jobId: id, pageNum: pageNumInt });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.error('[admin/page-retry] error', message);
    return NextResponse.json(
      { error: 'Could not retry page' },
      { status: 500 },
    );
  }
}
