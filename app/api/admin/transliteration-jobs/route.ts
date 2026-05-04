// Admin: list + summary stats for transliterationJobs.
// Read-only — does not mutate any field the worker depends on.

import { NextResponse } from 'next/server';
import { verifyAdminToken } from '@/lib/admin-auth';
import { adminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const admin = await verifyAdminToken(req);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const limitParam = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;

  try {
    const base = adminDb.collection('transliterationJobs');
    const query = status
      ? base.where('status', '==', status).limit(limit)
      : base.orderBy('createdAt', 'desc').limit(limit);

    const snap = await query.get();
    const items = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        uid: d.uid ?? null,
        email: d.email ?? null,
        filename: d.filename ?? null,
        status: d.status ?? 'unknown',
        totalPages: d.totalPages ?? 0,
        pagesCompleted: d.pagesCompleted ?? 0,
        translateRequested: d.translateRequested ?? false,
        translationStatus: d.translationStatus ?? null,
        createdAt: d.createdAt ?? null,
        updatedAt: d.updatedAt ?? null,
        startedAt: d.startedAt ?? null,
        completedAt: d.completedAt ?? null,
        error: d.error ?? null,
      };
    });
    if (status) items.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

    // Aggregated counts in parallel — single-field where, auto-indexed.
    const STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'];
    const counts: Record<string, number> = {};
    await Promise.all(
      STATUSES.map(async (s) => {
        const c = await adminDb
          .collection('transliterationJobs')
          .where('status', '==', s)
          .count()
          .get();
        counts[s] = c.data().count;
      }),
    );

    // Oldest pending — useful for spotting a stuck worker.
    const oldestPending = await adminDb
      .collection('transliterationJobs')
      .where('status', '==', 'pending')
      .limit(50)
      .get();
    const oldestPendingIso =
      oldestPending.docs
        .map((d) => d.data().createdAt as string | undefined)
        .filter((t): t is string => Boolean(t))
        .sort()[0] ?? null;

    // Worker heartbeat — most recent updatedAt across all running/done jobs.
    const recent = await adminDb
      .collection('transliterationJobs')
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();
    const lastWorkerActivityIso = recent.docs[0]?.data().updatedAt ?? null;

    return NextResponse.json({ items, counts, oldestPendingIso, lastWorkerActivityIso });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.error('[admin/transliteration-jobs] list error', message);
    return NextResponse.json({ error: 'Could not load jobs' }, { status: 500 });
  }
}
