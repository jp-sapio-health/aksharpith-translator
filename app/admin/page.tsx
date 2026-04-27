'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useAuth } from '../../lib/auth-context';
import { isAdminEmail } from '../../lib/admins';
import { getFirebaseDb } from '../../lib/firebase';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';

// ── Types ───────────────────────────────────────────────────────────────────

type StageStatus = 'pending' | 'running' | 'done' | 'error';

interface StageInfo {
  status?: StageStatus;
  completed?: number;
  total?: number;
  chunkCount?: number;
  avgScore?: number;          // reviewer telemetry, admin only
  flaggedChunks?: number;     // legacy smoother flag, admin only
  totalFixes?: number;
}

interface ChunkProgress {
  index: number;
  /** Translator self-flags (PR 4 contract, surfaced in admin chunk grid) */
  flags?: string[];
  /** Reviewer telemetry — admin only, populated when ENABLE_REVIEWER_TELEMETRY=true */
  score?: number;
  certifiable?: boolean;
  /** Legacy smoother fallback flag */
  flagged?: boolean;
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
    /** Admin-only reviewer telemetry; populated only when telemetry is enabled */
    avgScore?: number;
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
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-paper">
        <div className="mx-auto max-w-3xl px-5 py-4 flex items-baseline justify-between">
          <div>
            <h1 className="font-serif text-xl text-foreground">Aksharpith — Admin</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Live pipeline observer</p>
          </div>
          <a href="/" className="text-xs text-muted-foreground hover:text-foreground">← back to translator</a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-6">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <StatsLine stats={stats} />

        <ol className="mt-6 space-y-2">
          {jobs.length === 0 ? (
            <li className="rounded-md border bg-paper px-4 py-6 text-center text-sm text-muted-foreground">
              No jobs yet.
            </li>
          ) : (
            jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                expanded={openId === job.id}
                onToggle={() => setOpenId(openId === job.id ? null : job.id)}
              />
            ))
          )}
        </ol>
      </main>
    </div>
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

function JobRow({ job, expanded, onToggle }: { job: JobDoc; expanded: boolean; onToggle: () => void }) {
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
  // Admin sees the full pipeline including the (optional) reviewer telemetry stage.
  const stages = ['chunker', 'translator', 'reviewer', 'smoother', 'assembler', 'enforcer'] as const;

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
                {info?.avgScore !== undefined && info.avgScore > 0 && ` · avg ${info.avgScore}`}
                {info?.flaggedChunks !== undefined && info.flaggedChunks > 0 && ` · ${info.flaggedChunks} flagged`}
                {info?.totalFixes !== undefined && info.totalFixes > 0 && ` · ${info.totalFixes} fixes`}
              </span>
            </li>
          );
        })}
      </ul>

      {(job.progress?.chunks ?? []).length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1.5">
            Chunks
            <span className="ml-2 text-muted-foreground/70">
              (cell shows flag count; colour = reviewer score when telemetry on)
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-1">
            {job.progress!.chunks!.map((c) => {
              const flagCount = (c.flags ?? []).length;
              const score = c.score ?? 0;
              // Reviewer telemetry → score-based tone.
              // No telemetry → fall back to flag-count tone.
              const tone = score > 0
                ? (c.certifiable || score >= 96 ? 'bg-[oklch(0.85_0.04_145)] text-[oklch(0.32_0.07_145)]' :
                   score >= 80 ? 'bg-[oklch(0.88_0.04_75)] text-[oklch(0.35_0.08_75)]' :
                   'bg-destructive/15 text-destructive')
                : flagCount === 0 ? 'bg-paper-warm text-muted-foreground' :
                  flagCount <= 2 ? 'bg-[oklch(0.88_0.04_75)] text-[oklch(0.35_0.08_75)]' :
                  'bg-destructive/15 text-destructive';
              const tip = `#${c.index + 1}` +
                (score > 0 ? ` · score ${score}` : '') +
                ` · ${flagCount} flag${flagCount === 1 ? '' : 's'}` +
                (c.certifiable ? ' · cert' : '') +
                (c.flagged ? ' · smoother fallback' : '');
              return (
                <div
                  key={c.index}
                  title={tip}
                  className={cn('aspect-square rounded text-[10px] font-mono flex items-center justify-center tabular-nums', tone)}
                >
                  {score > 0 ? score : flagCount > 0 ? `${flagCount}f` : ''}
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
          {typeof job.result.avgScore === 'number' && (
            <span>Reviewer avg: <span className="font-mono text-foreground tabular-nums">{job.result.avgScore}</span></span>
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
