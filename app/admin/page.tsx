'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useAuth } from '../../lib/auth-context';
import { isAdminEmail } from '../../lib/admins';
import { getFirebaseDb } from '../../lib/firebase';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import type { TransliterationJobDocument } from '../../lib/job-types';

// ── Action helper ───────────────────────────────────────────────────────────
//
// Cancel / force-fail / delete actions hit /api/admin/{jobs|transliteration-jobs}/[id]
// with a Firebase ID token in the Authorization header. Server-side
// verifyAdminToken enforces both the custom claim AND the email allowlist.

type AdminAction = 'cancel' | 'force-fail' | 'delete';

async function runAdminAction(
  collectionPath: 'jobs' | 'transliteration-jobs',
  id: string,
  action: AdminAction,
  getToken: () => Promise<string | null>,
): Promise<{ ok: boolean; error?: string }> {
  const token = await getToken();
  if (!token) return { ok: false, error: 'No auth token' };

  const url = `/api/admin/${collectionPath}/${id}`;
  const opts: RequestInit =
    action === 'delete'
      ? { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
      : {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action }),
        };

  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

type StageStatus = 'pending' | 'running' | 'done' | 'error';

interface StageInfo {
  status?: StageStatus;
  completed?: number;
  total?: number;
  chunkCount?: number;
  totalFixes?: number;
}

interface ChunkProgress {
  index: number;
  /** Translator self-flags — surfaced in the chunk grid as the canonical signal. */
  flags?: string[];
}

interface JobDoc {
  id: string;
  uid: string;
  email: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  mode: 'local' | 'vercel';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  input: {
    text?: string;
    wordCount?: number;
    chapterTitle?: string | null;
    bookTitle?: string | null;
    chapterIndex?: number | null;
    totalChapters?: number | null;
  };
  progress: {
    currentStage?: string;
    stages?: Record<string, StageInfo>;
    chunks?: ChunkProgress[];
    commentary?: string;
  };
  result?: {
    output?: string;
    flagsCount?: number;
    totalFixes?: number;
  } | null;
}

// ── Page guard ──────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace('/login'); return; }
    user.getIdTokenResult(true)
      .then((result) => {
        const claim = result.claims.admin === true;
        const allowed = isAdminEmail(user.email);
        setIsAdmin(claim && allowed);
      })
      .catch(() => setIsAdmin(false));
  }, [user, authLoading, router]);

  if (authLoading || isAdmin === null) {
    return (
      <Center>
        <p className="text-sm text-muted-foreground">Verifying admin access…</p>
      </Center>
    );
  }

  if (!isAdmin) {
    return (
      <Center>
        <div className="max-w-sm text-center">
          <h1 className="font-serif text-2xl text-foreground mb-2">Admin access required</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as <span className="font-mono text-xs">{user?.email}</span>. This account is not on the admin allowlist.
          </p>
          <Button variant="outline" className="mt-6" onClick={() => router.replace('/')}>
            Back to translator
          </Button>
        </div>
      </Center>
    );
  }

  return <AdminFeed />;
}

// ── Feed (chronological list, expandable rows) ──────────────────────────────

function AdminFeed() {
  const { getIdToken } = useAuth();
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [bulkActing, setBulkActing] = useState(false);
  const [search, setSearch] = useState('');

  const onBulkAction = useCallback(
    async (
      kind: 'jobs' | 'transliteration-jobs',
      action:
        | 'cancel-pending'
        | 'force-fail-stuck'
        | 'delete-failed'
        | 'delete-cancelled',
    ) => {
      const labels: Record<typeof action, string> = {
        'cancel-pending': 'Cancel ALL pending jobs?',
        'force-fail-stuck': 'Force-fail ALL stuck/in-flight jobs? Worker may still emit completion writes.',
        'delete-failed': 'Permanently delete ALL failed jobs (and their pages)?',
        'delete-cancelled': 'Permanently delete ALL cancelled jobs (and their pages)?',
      };
      if (!confirm(labels[action])) return;
      setBulkActing(true);
      try {
        const token = await getIdToken();
        if (!token) {
          alert('No auth token');
          return;
        }
        const res = await fetch(`/api/admin/${kind}/bulk`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          alert(data?.error ?? 'Bulk action failed');
        } else {
          // Brief toast-style notification — onSnapshot will update the
          // list in real time, no manual refresh needed.
          console.info(`[admin] ${action}: ${data?.affected ?? 0} job(s) updated`);
        }
      } finally {
        setBulkActing(false);
      }
    },
    [getIdToken],
  );

  const onAction = useCallback(
    async (
      kind: 'jobs' | 'transliteration-jobs',
      id: string,
      action: AdminAction,
    ) => {
      if (action === 'delete' && !confirm('Delete this job permanently?')) return;
      setActing(id);
      const res = await runAdminAction(kind, id, action, getIdToken);
      if (!res.ok) alert(res.error ?? 'Action failed');
      setActing(null);
    },
    [getIdToken],
  );

  useEffect(() => {
    const db = getFirebaseDb();
    const q = query(collection(db, 'jobs'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next: JobDoc[] = [];
        snap.forEach((d) => next.push({ id: d.id, ...(d.data() as Omit<JobDoc, 'id'>) }));
        setJobs(next);
      },
      (err) => setError(err.message),
    );
    return unsub;
  }, []);

  const stats = useMemo(() => {
    const todayIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    return {
      pending: jobs.filter((j) => j.status === 'pending').length,
      running: jobs.filter((j) => j.status === 'running').length,
      doneToday: jobs.filter((j) => j.status === 'completed' && (j.completedAt ?? '') >= todayIso).length,
      failedToday: jobs.filter((j) => j.status === 'failed' && (j.completedAt ?? j.createdAt) >= todayIso).length,
      total: jobs.length,
    };
  }, [jobs]);

  // Search filter — case-insensitive match on email + chapter title +
  // book title + the first 200 chars of input. Empty search returns all.
  const filteredJobs = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return jobs;
    return jobs.filter((j) => {
      const haystack = [
        j.email,
        j.input?.chapterTitle ?? '',
        j.input?.bookTitle ?? '',
        (j.input?.text ?? '').slice(0, 200),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [jobs, search]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-paper">
        <div className="mx-auto max-w-3xl px-5 py-4 flex items-baseline justify-between">
          <div>
            <h1 className="font-serif text-xl text-foreground">Aksharpith — Admin</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Live pipeline observer</p>
          </div>
          <a href="/" className="text-xs text-muted-foreground hover:text-foreground">← back to Aksharpith</a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-6">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <StatsLine stats={stats} />

        {/* Search + bulk actions strip */}
        <div className="mt-4 flex flex-col gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search filename, email, chapter title…"
            className="w-full rounded-md border bg-paper px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground/10"
          />
          <div className="flex flex-wrap gap-1.5">
            <BulkButton disabled={bulkActing} onClick={() => onBulkAction('transliteration-jobs', 'cancel-pending')}>
              Cancel pending (translit)
            </BulkButton>
            <BulkButton tone="warn" disabled={bulkActing} onClick={() => onBulkAction('transliteration-jobs', 'force-fail-stuck')}>
              Force-fail stuck (translit)
            </BulkButton>
            <BulkButton tone="danger" disabled={bulkActing} onClick={() => onBulkAction('transliteration-jobs', 'delete-failed')}>
              Delete failed (translit)
            </BulkButton>
            <BulkButton tone="danger" disabled={bulkActing} onClick={() => onBulkAction('transliteration-jobs', 'delete-cancelled')}>
              Delete cancelled (translit)
            </BulkButton>
            <span className="mx-1 self-center text-muted-foreground">·</span>
            <BulkButton disabled={bulkActing} onClick={() => onBulkAction('jobs', 'cancel-pending')}>
              Cancel pending (legacy)
            </BulkButton>
            <BulkButton tone="warn" disabled={bulkActing} onClick={() => onBulkAction('jobs', 'force-fail-stuck')}>
              Force-fail stuck (legacy)
            </BulkButton>
          </div>
        </div>

        <h2 className="mt-6 mb-2 text-xs uppercase tracking-wider font-mono text-muted-foreground">Translation jobs (legacy paste flow)</h2>
        <ol className="space-y-2">
          {filteredJobs.length === 0 ? (
            <li className="rounded-md border bg-paper px-4 py-6 text-center text-sm text-muted-foreground">
              {search.trim() ? 'No legacy jobs match this search.' : 'No translation jobs yet.'}
            </li>
          ) : (
            filteredJobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                expanded={openId === job.id}
                onToggle={() => setOpenId(openId === job.id ? null : job.id)}
                onAction={(action) => onAction('jobs', job.id, action)}
                acting={acting === job.id}
              />
            ))
          )}
        </ol>

        <h2 className="mt-10 mb-2 text-xs uppercase tracking-wider font-mono text-muted-foreground">Transliteration jobs (page-by-page PDF flow)</h2>
        <TransliterationFeed
          search={search}
          onAction={(id, action) => onAction('transliteration-jobs', id, action)}
          acting={acting}
        />
      </main>
    </div>
  );
}

// ── Transliteration feed (new) ──────────────────────────────────────────────
//
// Subscribes to transliterationJobs/* and renders one row per job with
// page-completion ratio, status pill, and a link to /transliterate/{id} for
// full live progress. Admins see all users' jobs (Firestore rules permit it).

interface TransliterationJobRow extends TransliterationJobDocument {
  id: string;
}

function TransliterationFeed({
  search,
  onAction,
  acting,
}: {
  search: string;
  onAction: (id: string, action: AdminAction) => void;
  acting: string | null;
}) {
  const { getIdToken } = useAuth();
  const [jobs, setJobs] = useState<TransliterationJobRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filteredJobs = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return jobs;
    return jobs.filter((j) =>
      [j.filename ?? '', j.email ?? ''].join(' ').toLowerCase().includes(needle),
    );
  }, [jobs, search]);

  useEffect(() => {
    const db = getFirebaseDb();
    const q = query(collection(db, 'transliterationJobs'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next: TransliterationJobRow[] = [];
        snap.forEach((d) => next.push({ id: d.id, ...(d.data() as TransliterationJobDocument) }));
        setJobs(next);
      },
      (err) => setError(err.message),
    );
    return unsub;
  }, []);

  // Worker heartbeat + oldest pending — derived from the live snapshot.
  // The schema has no `updatedAt` on the parent doc, so we use the latest
  // of completedAt / startedAt / createdAt as the activity proxy.
  const heartbeat = useMemo(() => {
    const lastUpdate = jobs
      .map((j) => j.completedAt ?? j.startedAt ?? j.createdAt ?? '')
      .filter(Boolean)
      .sort()
      .pop();
    const oldestPending = jobs
      .filter((j) => j.status === 'pending')
      .map((j) => j.createdAt)
      .filter(Boolean)
      .sort()[0];
    return { lastUpdate, oldestPending };
  }, [jobs]);

  if (error) {
    return <p className="text-xs text-destructive">{error}</p>;
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-md border bg-paper px-4 py-6 text-center text-sm text-muted-foreground">
        No transliteration jobs yet.
      </div>
    );
  }

  if (filteredJobs.length === 0) {
    return (
      <div className="rounded-md border bg-paper px-4 py-6 text-center text-sm text-muted-foreground">
        No transliteration jobs match this search.
      </div>
    );
  }

  return (
    <>
      {/* Health strip */}
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {heartbeat.lastUpdate && (
          <span>
            Last worker write{' '}
            <span className="font-mono text-foreground">{formatAgo(heartbeat.lastUpdate)}</span>
          </span>
        )}
        {heartbeat.oldestPending && (
          <span
            className={cn(
              Date.now() - new Date(heartbeat.oldestPending).getTime() > 5 * 60_000 &&
                'text-[oklch(0.45_0.10_75)]',
            )}
          >
            Oldest pending{' '}
            <span className="font-mono text-foreground">{formatAgo(heartbeat.oldestPending)}</span>
          </span>
        )}
      </div>

      <ol className="space-y-2">
        {filteredJobs.map((job) => {
        const pct = job.totalPages > 0 ? Math.round((job.pagesCompleted / job.totalPages) * 100) : 0;
        const statusTone =
          job.status === 'done' ? 'text-[oklch(0.42_0.07_145)]' :
          job.status === 'failed' ? 'text-destructive' :
          'text-[oklch(0.45_0.10_75)]';
        return (
          <li key={job.id} className="rounded-md border bg-paper">
            <a
              href={`/transliterate/${job.id}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-stone-50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-serif text-sm text-foreground truncate">{job.filename}</span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">{job.email}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                  <span className="tabular-nums">{job.pagesCompleted}/{job.totalPages} pages</span>
                  <span>·</span>
                  <span>{new Date(job.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span>
                  {job.translateRequested && (
                    <>
                      <span>·</span>
                      <span>EN {job.translationStatus ?? 'pending'}</span>
                    </>
                  )}
                </div>
                {/* Mini progress bar */}
                <div className="mt-1.5 h-1 w-full bg-stone-200 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      'h-full transition-all',
                      job.status === 'failed' ? 'bg-destructive' : 'bg-amber-600',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
              <span className={cn('text-[10px] uppercase tracking-wider font-mono', statusTone)}>
                {job.status}
              </span>
            </a>
            {job.error && (
              <p className="px-4 pb-2 text-xs text-destructive">{job.error}</p>
            )}
            {/* Action row — TransliterationJobStatus is a tight enum but
                admin actions also yield 'cancelled'; cast to string so
                comparisons aren't narrowed away. In-flight covers the
                three middle worker states. */}
            {(() => {
              const s = job.status as string;
              const inFlight =
                s === 'ocr_running' || s === 'assembling' || s === 'transliterating';
              const showActions =
                s === 'pending' || inFlight || s === 'failed' || s === 'cancelled';
              if (!showActions) return null;
              return (
                <div className="flex items-center gap-1.5 px-4 pb-3">
                  {s === 'pending' && (
                    <ActionButton
                      tone="neutral"
                      disabled={acting === job.id}
                      onClick={() => onAction(job.id, 'cancel')}
                    >
                      Cancel
                    </ActionButton>
                  )}
                  {inFlight && (
                    <ActionButton
                      tone="warn"
                      disabled={acting === job.id}
                      onClick={() => onAction(job.id, 'force-fail')}
                    >
                      Force-fail
                    </ActionButton>
                  )}
                  <ActionButton
                    tone="danger"
                    disabled={acting === job.id}
                    onClick={() => onAction(job.id, 'delete')}
                  >
                    Delete
                  </ActionButton>
                  <ActionButton
                    tone="neutral"
                    onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
                  >
                    {expandedId === job.id ? 'Hide pages' : 'Pages…'}
                  </ActionButton>
                </div>
              );
            })()}
            {/* Pages panel — lazy-rendered so we don't subscribe to every
                job's pages subcollection up front. */}
            {expandedId === job.id && (
              <PagesPanel jobId={job.id} getToken={getIdToken} />
            )}
          </li>
        );
      })}
      </ol>
    </>
  );
}

// ── Pages panel (lazy per-job page list with retry) ────────────────────────
//
// Subscribes to a single job's `pages` subcollection only when expanded.
// Renders a chip per page colour-coded by status; failed pages get a
// 'Retry' button that flips them back to pending via the admin API.

function PagesPanel({
  jobId,
  getToken,
}: {
  jobId: string;
  getToken: () => Promise<string | null>;
}) {
  type PageRow = {
    pageNum: number;
    status: 'pending' | 'ocr_running' | 'ocr_done' | 'ocr_failed';
    error?: string | null;
    attempts?: number;
  };
  const [pages, setPages] = useState<PageRow[]>([]);
  const [retrying, setRetrying] = useState<number | null>(null);

  useEffect(() => {
    const db = getFirebaseDb();
    const q = query(
      collection(db, 'transliterationJobs', jobId, 'pages'),
      orderBy('pageNum'),
    );
    const unsub = onSnapshot(q, (snap) => {
      const next: PageRow[] = [];
      snap.forEach((d) => next.push(d.data() as PageRow));
      setPages(next);
    });
    return unsub;
  }, [jobId]);

  async function retry(pageNum: number) {
    setRetrying(pageNum);
    try {
      const token = await getToken();
      if (!token) {
        alert('No auth token');
        return;
      }
      const res = await fetch(
        `/api/admin/transliteration-jobs/${jobId}/pages/${pageNum}/retry`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) alert(data?.error ?? 'Retry failed');
    } finally {
      setRetrying(null);
    }
  }

  const failed = pages.filter((p) => p.status === 'ocr_failed');

  const tone: Record<PageRow['status'], string> = {
    pending: 'bg-stone-100 text-stone-500 border-stone-200',
    ocr_running: 'bg-amber-100 text-amber-800 border-amber-200 animate-pulse',
    ocr_done: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    ocr_failed: 'bg-destructive/10 text-destructive border-destructive/30',
  };

  return (
    <div className="border-t border-stone-200 bg-paper-warm/40 px-4 py-3 space-y-3">
      {pages.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading pages…</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            {pages.map((p) => (
              <span
                key={p.pageNum}
                title={`Page ${p.pageNum} · ${p.status}${p.error ? ` — ${p.error}` : ''}${p.attempts ? ` · ${p.attempts} attempt${p.attempts === 1 ? '' : 's'}` : ''}`}
                className={cn(
                  'inline-flex items-center justify-center h-6 min-w-[2rem] px-1.5 rounded border text-[11px] font-mono tabular-nums',
                  tone[p.status],
                )}
              >
                {p.pageNum}
              </span>
            ))}
          </div>
          {failed.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No failed pages. {pages.filter((p) => p.status === 'ocr_done').length} of {pages.length} complete.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] font-mono uppercase tracking-wider text-destructive">
                {failed.length} failed page{failed.length === 1 ? '' : 's'}
              </p>
              <div className="flex flex-col gap-1.5">
                {failed.map((p) => (
                  <div
                    key={p.pageNum}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span className="font-mono w-12 text-muted-foreground">p.{p.pageNum}</span>
                    <span className="flex-1 text-destructive truncate">
                      {p.error ?? 'OCR failed'}
                      {p.attempts != null && (
                        <span className="text-muted-foreground"> · {p.attempts} attempt{p.attempts === 1 ? '' : 's'}</span>
                      )}
                    </span>
                    <ActionButton
                      tone="warn"
                      disabled={retrying === p.pageNum}
                      onClick={() => retry(p.pageNum)}
                    >
                      {retrying === p.pageNum ? '…' : 'Retry'}
                    </ActionButton>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Bulk button ─────────────────────────────────────────────────────────────
//
// Slightly bigger than ActionButton (the pill-style row buttons) — meant to
// sit at the top of the feed and apply across the entire matching status set.

function BulkButton({
  tone = 'neutral',
  disabled,
  onClick,
  children,
}: {
  tone?: 'neutral' | 'warn' | 'danger';
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const palette =
    tone === 'danger'
      ? 'border-destructive/30 text-destructive hover:bg-destructive/5'
      : tone === 'warn'
        ? 'border-[oklch(0.85_0.06_75)] text-[oklch(0.45_0.10_75)] hover:bg-[oklch(0.95_0.04_75)]'
        : 'border-border text-muted-foreground hover:bg-paper-warm hover:text-foreground';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'text-[11px] font-mono uppercase tracking-wider px-2.5 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        palette,
      )}
    >
      {children}
    </button>
  );
}

// ── Action button ───────────────────────────────────────────────────────────

function ActionButton({
  tone,
  disabled,
  onClick,
  children,
}: {
  tone: 'neutral' | 'warn' | 'danger';
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  const palette =
    tone === 'danger'
      ? 'border-destructive/30 text-destructive hover:bg-destructive/5'
      : tone === 'warn'
        ? 'border-[oklch(0.85_0.06_75)] text-[oklch(0.45_0.10_75)] hover:bg-[oklch(0.95_0.04_75)]'
        : 'border-border text-muted-foreground hover:bg-paper-warm hover:text-foreground';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={cn(
        'text-[11px] font-mono uppercase tracking-wider px-2.5 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        palette,
      )}
    >
      {children}
    </button>
  );
}

// ── Stats line ──────────────────────────────────────────────────────────────

function StatsLine({ stats }: { stats: { pending: number; running: number; doneToday: number; failedToday: number; total: number } }) {
  const item = (label: string, value: number) => (
    <span className="text-xs text-muted-foreground">
      <span className="font-mono text-foreground tabular-nums">{value}</span> {label}
    </span>
  );
  return (
    <p className="text-xs text-muted-foreground">
      {item('pending', stats.pending)} · {item('running', stats.running)} · {item('done today', stats.doneToday)}
      {stats.failedToday > 0 && <> · {item('failed today', stats.failedToday)}</>}
      {' · '}<span className="text-xs text-muted-foreground/70">{stats.total} total</span>
    </p>
  );
}

// ── Job row ─────────────────────────────────────────────────────────────────

function JobRow({
  job,
  expanded,
  onToggle,
  onAction,
  acting,
}: {
  job: JobDoc;
  expanded: boolean;
  onToggle: () => void;
  onAction: (action: AdminAction) => void;
  acting: boolean;
}) {
  const stage = job.progress?.currentStage ?? '—';
  const commentary = job.progress?.commentary;
  const title = job.input?.bookTitle ?? job.input?.chapterTitle ?? `Job ${job.id.slice(0, 8)}`;
  const wordCount = job.input?.wordCount ?? 0;
  const isBook = (job.input?.totalChapters ?? 0) > 0;
  const chapterPart = isBook
    ? ` · ch ${(job.input?.chapterIndex ?? 0) + 1}/${job.input?.totalChapters}`
    : '';

  return (
    <li className="rounded-md border bg-paper">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 hover:bg-paper-warm transition-colors rounded-md"
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-serif text-base text-foreground truncate">{title}</div>
            <div className="text-xs text-muted-foreground mt-0.5 truncate">
              <span className="font-mono">{job.email || 'unknown'}</span>
              {' · '}{wordCount.toLocaleString()} words{chapterPart}
              {' · '}{formatAgo(job.createdAt)}
            </div>
            {job.status === 'running' && commentary && (
              <p className="mt-1.5 text-xs italic text-muted-foreground line-clamp-1">{commentary}</p>
            )}
          </div>
          <StatusPill status={job.status} stage={stage} />
        </div>
      </button>

      {/* Action row — visible inline when expanded so the click target on
          the main row stays a single toggle. */}
      {expanded && (
        <div className="flex items-center gap-1.5 px-4 pb-3">
          {(job.status as string) === 'pending' && (
            <ActionButton tone="neutral" disabled={acting} onClick={() => onAction('cancel')}>
              Cancel
            </ActionButton>
          )}
          {(job.status as string) === 'running' && (
            <ActionButton tone="warn" disabled={acting} onClick={() => onAction('force-fail')}>
              Force-fail
            </ActionButton>
          )}
          <ActionButton tone="danger" disabled={acting} onClick={() => onAction('delete')}>
            Delete
          </ActionButton>
        </div>
      )}

      {expanded && <JobDetails job={job} />}
    </li>
  );
}

function StatusPill({ status, stage }: { status: JobDoc['status']; stage: string }) {
  const tone =
    status === 'completed' ? 'text-[oklch(0.42_0.07_145)]' :
    status === 'failed' ? 'text-destructive' :
    status === 'running' ? 'text-[oklch(0.45_0.10_75)]' :
    'text-muted-foreground';
  return (
    <div className="flex items-baseline gap-2 shrink-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{stage}</span>
      <span className={cn('text-[10px] uppercase tracking-wider font-mono', tone)}>{status}</span>
    </div>
  );
}

// ── Job details (expanded) ──────────────────────────────────────────────────

function JobDetails({ job }: { job: JobDoc }) {
  // Sadhu-approved chain — five stages, no reviewer.
  const stages = ['chunker', 'translator', 'smoother', 'assembler', 'enforcer'] as const;

  return (
    <div className="border-t bg-paper-warm/40 px-4 py-4 space-y-4 text-xs">
      <div className="text-muted-foreground">
        <span className="font-mono">{job.id}</span>
        {job.startedAt && <> · started {formatAgo(job.startedAt)}</>}
        {job.completedAt && <> · completed {formatAgo(job.completedAt)}</>}
      </div>

      {job.error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-destructive whitespace-pre-wrap">
          {job.error}
        </div>
      )}

      <ul className="space-y-1">
        {stages.map((s) => {
          const info = job.progress?.stages?.[s];
          const status = info?.status ?? 'pending';
          const isCurrent = job.progress?.currentStage === s;
          const dot =
            status === 'done' ? '✓' :
            status === 'running' ? '→' :
            status === 'error' ? '✗' :
            '·';
          return (
            <li key={s} className={cn('grid grid-cols-[16px_92px_1fr] items-baseline gap-2', isCurrent && 'text-foreground')}>
              <span className="font-mono text-muted-foreground">{dot}</span>
              <span className="capitalize text-muted-foreground">{s}</span>
              <span className="text-muted-foreground">
                {info?.completed !== undefined && info?.total !== undefined && `${info.completed}/${info.total}`}
                {info?.chunkCount !== undefined && ` · ${info.chunkCount} chunks`}
                {info?.totalFixes !== undefined && info.totalFixes > 0 && ` · ${info.totalFixes} fixes`}
              </span>
            </li>
          );
        })}
      </ul>

      {job.progress?.commentary && (
        <p className="italic text-muted-foreground">{job.progress.commentary}</p>
      )}

      {(job.progress?.chunks ?? []).length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1.5">
            Chunks
            <span className="ml-2 text-muted-foreground/70">
              (cell shows translator self-flag count; green = none, amber = 1–2, red = 3+)
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-1">
            {job.progress!.chunks!.map((c) => {
              const flagCount = (c.flags ?? []).length;
              const tone =
                flagCount === 0 ? 'bg-[oklch(0.94_0.04_145)] text-[oklch(0.40_0.10_145)]' :
                flagCount <= 2 ? 'bg-[oklch(0.95_0.04_75)] text-[oklch(0.42_0.11_75)]' :
                'bg-destructive/15 text-destructive';
              const tip = `#${c.index + 1} · ${flagCount} flag${flagCount === 1 ? '' : 's'}`;
              return (
                <div
                  key={c.index}
                  title={tip}
                  className={cn('aspect-square rounded text-[10px] font-mono flex items-center justify-center tabular-nums', tone)}
                >
                  {flagCount > 0 ? `${flagCount}f` : '·'}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {job.result && (
        <div className="text-muted-foreground space-x-3">
          {typeof job.result.flagsCount === 'number' && (
            <span>Total self-flags: <span className="font-mono text-foreground tabular-nums">{job.result.flagsCount}</span></span>
          )}
          {typeof job.result.totalFixes === 'number' && job.result.totalFixes > 0 && (
            <span>Enforcer fixes: <span className="font-mono text-foreground tabular-nums">{job.result.totalFixes}</span></span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
      {children}
    </div>
  );
}

function formatAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const d = Math.max(0, Date.now() - t);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
