'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useAuth } from '../../lib/auth-context';
import { isAdminEmail } from '../../lib/admins';
import { getFirebaseDb } from '../../lib/firebase';

// ── Types ───────────────────────────────────────────────────────────────────

type StageStatus = 'pending' | 'running' | 'done' | 'error';

interface StageInfo {
  status?: StageStatus;
  completed?: number;
  total?: number;
  chunkCount?: number;
  rechecked?: number;
  certCount?: number;
  avgScore?: number;
  flaggedChunks?: number;
  totalFixes?: number;
}

interface ChunkProgress {
  index: number;
  original?: string;
  translation?: string;
  score?: number;
  certifiable?: boolean;
  flagged?: boolean;
  reviewRound?: number;
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
  input: { text?: string; wordCount?: number; chapterTitle?: string | null; bookTitle?: string | null; chapterIndex?: number | null; totalChapters?: number | null };
  progress: {
    currentStage?: string;
    stages?: Record<string, StageInfo>;
    chunks?: ChunkProgress[];
    commentary?: string;
  };
  result?: { avgScore?: number; output?: string } | null;
}

type StatusFilter = 'all' | 'pending' | 'running' | 'completed' | 'failed';

// ── Palette ─────────────────────────────────────────────────────────────────

const C = {
  bg: 'linear-gradient(135deg, #fdf6ec 0%, #f5efe0 50%, #e8e0d0 100%)',
  panel: '#ffffff',
  panelMuted: '#fbf6ec',
  border: '#e0d4bd',
  text: '#2a2418',
  textMuted: '#7a6f5a',
  accent: '#a8763a',
  pending: '#9a8e72',
  running: '#c89232',
  done: '#5b8a4f',
  failed: '#b05050',
};

// ── Page ────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace('/login'); return; }
    user.getIdTokenResult(true).then((result) => {
      const claim = result.claims.admin === true;
      const allowed = isAdminEmail(user.email);
      setIsAdmin(claim && allowed);
    }).catch(() => setIsAdmin(false));
  }, [user, authLoading, router]);

  if (authLoading || isAdmin === null) {
    return <CenterMessage>Verifying admin access…</CenterMessage>;
  }

  if (!isAdmin) {
    return (
      <CenterMessage>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Admin access required</div>
          <div style={{ color: C.textMuted, fontSize: '0.95rem' }}>
            Signed in as {user?.email}. This account is not on the admin allowlist.
          </div>
          <button onClick={() => router.replace('/')} style={btnSecondary}>Back to translator</button>
        </div>
      </CenterMessage>
    );
  }

  return <AdminDashboard />;
}

// ── Dashboard ───────────────────────────────────────────────────────────────

function AdminDashboard() {
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      (err) => setError(err.message)
    );
    return unsub;
  }, []);

  const stats = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();
    return {
      pending: jobs.filter((j) => j.status === 'pending').length,
      running: jobs.filter((j) => j.status === 'running').length,
      doneToday: jobs.filter((j) => j.status === 'completed' && (j.completedAt ?? '') >= todayIso).length,
      failedToday: jobs.filter((j) => j.status === 'failed' && (j.completedAt ?? j.createdAt) >= todayIso).length,
      total: jobs.length,
    };
  }, [jobs]);

  const filtered = useMemo(() => {
    if (filter === 'all') return jobs;
    return jobs.filter((j) => j.status === filter);
  }, [jobs, filter]);

  const selected = jobs.find((j) => j.id === selectedId) ?? null;

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'Karla', sans-serif", color: C.text }}>
      <header style={{ padding: '1.5rem 2rem', borderBottom: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(8px)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', maxWidth: '1400px', margin: '0 auto' }}>
          <div>
            <h1 style={{ margin: 0, fontFamily: "'Cormorant Garamond', serif", fontSize: '1.85rem', fontWeight: 500, color: C.text }}>Aksharpith Admin</h1>
            <div style={{ fontSize: '0.85rem', color: C.textMuted, marginTop: '0.25rem' }}>Live pipeline observer · all jobs across all users</div>
          </div>
          <a href="/" style={{ color: C.accent, textDecoration: 'none', fontSize: '0.9rem' }}>← back to translator</a>
        </div>
      </header>

      <main style={{ maxWidth: '1400px', margin: '0 auto', padding: '1.5rem 2rem' }}>
        {error && (
          <div style={{ background: '#fbeded', border: `1px solid ${C.failed}`, padding: '0.75rem 1rem', borderRadius: '6px', marginBottom: '1rem', color: C.failed, fontSize: '0.9rem' }}>
            {error}
          </div>
        )}

        <StatsBar stats={stats} />

        <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1.4fr' : '1fr', gap: '1.5rem', marginTop: '1.5rem' }}>
          <section>
            <FilterChips value={filter} onChange={setFilter} stats={stats} />
            <JobList jobs={filtered} selectedId={selectedId} onSelect={setSelectedId} />
          </section>
          {selected && <JobDetail job={selected} onClose={() => setSelectedId(null)} />}
        </div>
      </main>
    </div>
  );
}

// ── Stats ───────────────────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: { pending: number; running: number; doneToday: number; failedToday: number; total: number } }) {
  const cards: Array<[string, number, string]> = [
    ['Pending', stats.pending, C.pending],
    ['Running', stats.running, C.running],
    ['Done today', stats.doneToday, C.done],
    ['Failed today', stats.failedToday, C.failed],
    ['Total all-time', stats.total, C.textMuted],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.75rem' }}>
      {cards.map(([label, value, colour]) => (
        <div key={label} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '1rem' }}>
          <div style={{ fontSize: '0.75rem', color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
          <div style={{ fontSize: '1.85rem', fontFamily: "'Cormorant Garamond', serif", color: colour, marginTop: '0.25rem' }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Filter chips ────────────────────────────────────────────────────────────

function FilterChips({ value, onChange, stats }: { value: StatusFilter; onChange: (v: StatusFilter) => void; stats: { pending: number; running: number; total: number } }) {
  const chips: Array<[StatusFilter, string, number?]> = [
    ['all', 'All', stats.total],
    ['pending', 'Pending', stats.pending],
    ['running', 'Running', stats.running],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
  ];
  return (
    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
      {chips.map(([key, label, count]) => {
        const active = value === key;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            style={{
              padding: '0.4rem 0.85rem',
              borderRadius: '999px',
              border: `1px solid ${active ? C.accent : C.border}`,
              background: active ? C.accent : C.panel,
              color: active ? '#fff' : C.text,
              fontSize: '0.85rem',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {label}{count !== undefined && <span style={{ marginLeft: '0.4rem', opacity: 0.7 }}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ── Job list ────────────────────────────────────────────────────────────────

function JobList({ jobs, selectedId, onSelect }: { jobs: JobDoc[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (jobs.length === 0) {
    return (
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '2rem', textAlign: 'center', color: C.textMuted }}>
        No jobs match this filter.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {jobs.map((j) => (
        <JobRow key={j.id} job={j} selected={j.id === selectedId} onClick={() => onSelect(j.id)} />
      ))}
    </div>
  );
}

function JobRow({ job, selected, onClick }: { job: JobDoc; selected: boolean; onClick: () => void }) {
  const stageBadgeColour = job.status === 'completed' ? C.done : job.status === 'failed' ? C.failed : job.status === 'running' ? C.running : C.pending;
  const title = job.input.bookTitle ?? job.input.chapterTitle ?? `Job ${job.id.slice(0, 8)}`;
  const wordCount = job.input.wordCount ?? job.input.text?.split(/\s+/).filter(Boolean).length ?? 0;
  const stageLabel = job.progress?.currentStage ?? '—';
  const ago = formatAgo(job.createdAt);

  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '0.85rem 1rem',
        background: selected ? C.panelMuted : C.panel,
        border: `1px solid ${selected ? C.accent : C.border}`,
        borderRadius: '8px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: 'inherit',
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: '0.5rem',
      }}
    >
      <div>
        <div style={{ fontSize: '0.95rem', fontWeight: 500 }}>{title}</div>
        <div style={{ fontSize: '0.78rem', color: C.textMuted, marginTop: '0.2rem' }}>
          {job.email || 'unknown user'} · {wordCount.toLocaleString()} words · {ago}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ fontSize: '0.75rem', color: C.textMuted }}>{stageLabel}</span>
        <span style={{ display: 'inline-block', padding: '0.2rem 0.6rem', borderRadius: '999px', background: stageBadgeColour, color: '#fff', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {job.status}
        </span>
      </div>
    </button>
  );
}

// ── Job detail ──────────────────────────────────────────────────────────────

function JobDetail({ job, onClose }: { job: JobDoc; onClose: () => void }) {
  const stages = ['chunker', 'translator', 'reviewer', 'smoother', 'assembler', 'enforcer'] as const;

  return (
    <aside style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '1.25rem', alignSelf: 'start', position: 'sticky', top: '1rem', maxHeight: 'calc(100vh - 2rem)', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: '1.3rem' }}>
          {job.input.bookTitle ?? job.input.chapterTitle ?? 'Untitled job'}
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: '1.2rem' }}>×</button>
      </div>
      <div style={{ fontSize: '0.78rem', color: C.textMuted, marginBottom: '1rem' }}>
        {job.email} · {job.id.slice(0, 12)} · {job.mode}
      </div>

      {job.error && (
        <div style={{ background: '#fbeded', border: `1px solid ${C.failed}`, padding: '0.75rem', borderRadius: '6px', marginBottom: '1rem', color: C.failed, fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>
          {job.error}
        </div>
      )}

      {job.progress?.commentary && job.status === 'running' && (
        <div style={{ background: C.panelMuted, padding: '0.75rem', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.85rem', color: C.text, fontStyle: 'italic' }}>
          {job.progress.commentary}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '1rem' }}>
        {stages.map((s) => {
          const info = job.progress?.stages?.[s];
          const status = info?.status ?? 'pending';
          const isCurrent = job.progress?.currentStage === s;
          const colour = status === 'done' ? C.done : status === 'running' ? C.running : status === 'error' ? C.failed : C.pending;
          return (
            <div key={s} style={{ display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: '0.5rem', alignItems: 'center', padding: '0.4rem 0.6rem', background: isCurrent ? C.panelMuted : 'transparent', borderRadius: '4px' }}>
              <span style={{ fontSize: '0.85rem', textTransform: 'capitalize', color: C.text }}>{s}</span>
              <span style={{ fontSize: '0.75rem', color: C.textMuted }}>
                {info?.completed !== undefined && info?.total !== undefined && `${info.completed}/${info.total}`}
                {info?.chunkCount !== undefined && ` · ${info.chunkCount} chunks`}
                {info?.avgScore !== undefined && info.avgScore > 0 && ` · avg ${info.avgScore}`}
                {info?.flaggedChunks !== undefined && info.flaggedChunks > 0 && ` · ${info.flaggedChunks} flagged`}
                {info?.totalFixes !== undefined && ` · ${info.totalFixes} fixes`}
              </span>
              <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: colour }} />
            </div>
          );
        })}
      </div>

      {(job.progress?.chunks ?? []).length > 0 && (
        <details style={{ marginBottom: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.85rem', color: C.textMuted }}>
            Chunks ({job.progress!.chunks!.length})
          </summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(48px, 1fr))', gap: '4px', marginTop: '0.5rem' }}>
            {job.progress!.chunks!.map((c) => {
              const score = c.score ?? 0;
              const colour = c.flagged ? C.failed : c.certifiable ? C.done : score >= 96 ? C.done : score >= 80 ? C.running : score > 0 ? C.failed : C.border;
              return (
                <div key={c.index} title={`#${c.index + 1} score ${score}${c.certifiable ? ' (cert)' : ''}${c.flagged ? ' (flagged)' : ''}`}
                     style={{ aspectRatio: '1', background: colour, borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '0.65rem' }}>
                  {score || ''}
                </div>
              );
            })}
          </div>
        </details>
      )}

      {job.result && (
        <div style={{ background: C.panelMuted, padding: '0.75rem', borderRadius: '6px', fontSize: '0.85rem' }}>
          <div style={{ color: C.textMuted, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.4rem' }}>Result</div>
          <div>Avg score: <strong>{job.result.avgScore ?? '—'}</strong></div>
          {job.completedAt && <div style={{ color: C.textMuted, marginTop: '0.25rem' }}>Completed {formatAgo(job.completedAt)}</div>}
        </div>
      )}
    </aside>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function CenterMessage({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Karla', sans-serif", color: C.text, padding: '2rem' }}>
      <div>{children}</div>
    </div>
  );
}

function formatAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const btnSecondary: React.CSSProperties = {
  marginTop: '1rem',
  padding: '0.5rem 1rem',
  background: 'transparent',
  border: `1px solid ${C.border}`,
  borderRadius: '6px',
  color: C.text,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '0.9rem',
};
