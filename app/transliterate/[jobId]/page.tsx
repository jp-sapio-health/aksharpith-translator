'use client';

import { useEffect, useState, useMemo, use } from 'react';
import { doc, onSnapshot, collection, query, orderBy, updateDoc } from 'firebase/firestore';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../../lib/auth-context';
import { getFirebaseDb } from '../../../lib/firebase';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { cn } from '../../../lib/utils';
import type {
  TransliterationJobDocument,
  PageJob,
  TransliterationJobStatus,
  TranslationStatus,
} from '../../../lib/job-types';

// ─── Status pills ──────────────────────────────────────────────────────────
//
// Per Sally's UX brief: page chips colour-coded by status. ink-green =
// done, amber pulse = OCR'ing, muted = queued, red = error.

const PAGE_STATUS_COLOURS: Record<PageJob['status'], string> = {
  pending:     'bg-stone-200 text-stone-500',
  ocr_running: 'bg-amber-200 text-amber-900 animate-pulse',
  ocr_done:    'bg-emerald-200 text-emerald-900',
  ocr_failed:  'bg-red-200 text-red-900',
};

const STATUS_LABEL: Record<TransliterationJobStatus, string> = {
  pending: 'Queued',
  ocr_running: 'OCR in progress',
  assembling: 'Assembling pages',
  transliterating: 'Transliterating',
  done: 'Complete',
  failed: 'Failed',
};

export default function TransliterationJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  // Next.js 15 wraps params in a Promise; unwrap with `use()`.
  const { jobId } = use(params);
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [job, setJob] = useState<(TransliterationJobDocument & { id: string }) | null>(null);
  const [pages, setPages] = useState<PageJob[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // Keyboard nav: j/k or ↓/↑ scrolls between page cards. Works once at
  // least one page is rendered. Plain global handler — page cards are
  // identified by id="page-N".
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Skip if focused on a form field or text editing.
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const dir = e.key === 'j' || e.key === 'ArrowDown' ? 1
        : e.key === 'k' || e.key === 'ArrowUp' ? -1
        : 0;
      if (!dir) return;
      e.preventDefault();
      const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-page-card]'));
      if (cards.length === 0) return;
      const y = window.scrollY + 120; // offset for sticky header
      const idx = cards.findIndex((c) => c.offsetTop > y);
      const targetIdx =
        dir > 0
          ? (idx === -1 ? cards.length - 1 : idx)
          : Math.max(0, (idx === -1 ? cards.length : idx) - 2);
      cards[Math.max(0, Math.min(cards.length - 1, targetIdx))]?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      /* swallow */
    }
  }

  // Redirect anonymous users to login.
  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  // Subscribe to the parent job doc.
  useEffect(() => {
    if (!user) return;
    const db = getFirebaseDb();
    const unsub = onSnapshot(
      doc(db, 'transliterationJobs', jobId),
      (snap) => {
        if (!snap.exists()) { setJob(null); return; }
        const data = snap.data() as TransliterationJobDocument;
        if (data.uid !== user.uid) { setForbidden(true); return; }
        setJob({ ...data, id: snap.id });
      },
      (err) => { console.error('[transliterate] parent subscribe error:', err); },
    );
    return unsub;
  }, [jobId, user]);

  // Subscribe to the pages subcollection.
  useEffect(() => {
    if (!user || forbidden) return;
    const db = getFirebaseDb();
    const q = query(collection(db, 'transliterationJobs', jobId, 'pages'), orderBy('pageNum'));
    const unsub = onSnapshot(
      q,
      (snap) => setPages(snap.docs.map(d => d.data() as PageJob)),
      (err) => { console.error('[transliterate] pages subscribe error:', err); },
    );
    return unsub;
  }, [jobId, user, forbidden]);

  // Pages where transliteration has populated. We render per-page sections
  // from these (Sally's UX brief: collapsible page sections, eye icon to
  // toggle the original Gujarati under each Roman line).
  const transliteratedPages = useMemo(
    () => pages.filter(p => (p.transliteratedText ?? '').trim().length > 0),
    [pages],
  );

  // Track which page sections have their "view original Gujarati" expanded.
  const [openOriginals, setOpenOriginals] = useState<Set<number>>(new Set());
  const toggleOriginal = (pageNum: number) => {
    setOpenOriginals(prev => {
      const next = new Set(prev);
      if (next.has(pageNum)) next.delete(pageNum); else next.add(pageNum);
      return next;
    });
  };

  function renderTransliteratedBlocks(text: string) {
    // Convert <verse>…</verse> markers to italic styled paragraphs; strip
    // the markup itself. Plain prose paragraphs render normally.
    return text.split(/\n\n/).map((block, i) => {
      const trimmed = block.trim();
      if (!trimmed) return null;
      if (/<verse>[\s\S]*?<\/verse>/.test(trimmed)) {
        const inner = trimmed.replace(/<\/?verse>/g, '');
        return (
          <p key={i} className="italic text-stone-700 border-l-4 border-amber-600 pl-4 my-3">{inner}</p>
        );
      }
      return <p key={i} className="my-2 leading-relaxed">{trimmed}</p>;
    });
  }

  const triggerTranslation = async () => {
    if (!job) return;
    setTranslating(true);
    try {
      const db = getFirebaseDb();
      await updateDoc(doc(db, 'transliterationJobs', jobId), {
        translateRequested: true,
        translationStatus: 'pending',
      });
    } catch (err) {
      console.error('[transliterate] failed to trigger translation:', err);
      setTranslating(false);
    }
  };

  const downloadText = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const downloadDocx = async (kind: 'transliteration' | 'translation') => {
    const content = kind === 'transliteration' ? job?.transliteratedOutput : job?.translationOutput;
    if (!content) return;
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'docx', output: content }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(job?.filename ?? 'output').replace(/\.[^.]+$/, '')}-${kind}.docx`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  if (authLoading) return <div className="p-12 text-stone-500">Loading…</div>;
  if (forbidden) return <div className="p-12 text-red-700">You don&apos;t have access to this job.</div>;
  if (!job) return <div className="p-12 text-stone-500">Loading job {jobId}…</div>;

  const overallProgress = job.totalPages > 0
    ? Math.round((job.pagesCompleted / job.totalPages) * 100)
    : 0;

  return (
    <main className="min-h-screen bg-stone-50">
      {/* Sticky progress rail */}
      <header className="sticky top-0 z-10 bg-white border-b border-stone-200 px-6 py-4 shadow-sm">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold truncate">{job.filename}</h1>
            <p className="text-sm text-stone-500">
              <Badge variant="outline" className="mr-2">{STATUS_LABEL[job.status]}</Badge>
              {job.pagesCompleted} / {job.totalPages} pages
              {job.status === 'transliterating' && ' · transliterating…'}
              {job.error && <span className="text-red-700 ml-2">{job.error}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={copyShareLink}
              title="Copy a shareable link to this job"
            >
              {linkCopied ? '✓ Copied' : 'Share link'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => router.push('/')}>← New upload</Button>
          </div>
        </div>
        {/* Linear progress bar */}
        <div className="max-w-6xl mx-auto mt-3">
          <div className="h-2 w-full bg-stone-200 rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full transition-all duration-300',
                job.status === 'failed' ? 'bg-red-500' : 'bg-amber-600',
              )}
              style={{ width: `${overallProgress}%` }}
            />
          </div>
        </div>
        {/* Page chip strip */}
        {pages.length > 0 && (
          <div className="max-w-6xl mx-auto mt-3 flex gap-1 overflow-x-auto pb-1">
            {pages.map((p) => (
              <span
                key={p.pageNum}
                title={`Page ${p.pageNum}: ${p.status}${p.error ? ` — ${p.error}` : ''}`}
                className={cn(
                  'flex-shrink-0 inline-flex items-center justify-center h-6 min-w-[1.75rem] px-1.5 rounded text-xs font-mono',
                  PAGE_STATUS_COLOURS[p.status],
                )}
              >
                {p.pageNum}
              </span>
            ))}
          </div>
        )}
      </header>

      {/* Two-pane workspace */}
      <div className="max-w-6xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left pane: source Gujarati */}
        <section className="bg-white rounded-lg border border-stone-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-stone-700">Source — Gujarati</h2>
            {job.gujaratiOutput && (
              <Button variant="ghost" size="sm" onClick={() => downloadText(`${job.filename.replace(/\.[^.]+$/, '')}-gujarati.txt`, job.gujaratiOutput!)}>
                .txt
              </Button>
            )}
          </div>
          {job.gujaratiOutput ? (
            <pre className="whitespace-pre-wrap font-serif text-stone-800 text-sm leading-relaxed max-h-[70vh] overflow-y-auto">{job.gujaratiOutput}</pre>
          ) : (
            <p className="text-stone-400 italic">Assembled Gujarati will appear here once all pages OCR.</p>
          )}
        </section>

        {/* Right pane: per-page transliteration sections (the hero) */}
        <section className="bg-white rounded-lg border border-amber-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-amber-900">Transliteration (Roman, ā-only)</h2>
            {job.transliteratedOutput && (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => downloadText(`${job.filename.replace(/\.[^.]+$/, '')}-translit.txt`, job.transliteratedOutput!)}>
                  .txt
                </Button>
                <Button variant="ghost" size="sm" onClick={() => downloadDocx('transliteration')}>
                  .docx
                </Button>
              </div>
            )}
          </div>
          {transliteratedPages.length === 0 ? (
            <p className="text-stone-400 italic">
              {job.status === 'transliterating' ? 'Transliterating now…' : 'Awaiting OCR completion.'}
            </p>
          ) : (
            <div className="font-serif text-stone-800 text-sm max-h-[75vh] overflow-y-auto space-y-4">
              {transliteratedPages.map((p) => {
                const open = openOriginals.has(p.pageNum);
                return (
                  <article
                    key={p.pageNum}
                    id={`page-${p.pageNum}`}
                    data-page-card
                    className="border-b border-stone-100 last:border-0 pb-3 scroll-mt-32"
                  >
                    <header className="flex items-center justify-between mb-2 sticky top-0 bg-white py-1">
                      <span className="text-xs font-mono uppercase tracking-wider text-stone-500">
                        Page {p.pageNum}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleOriginal(p.pageNum)}
                        title={open ? 'Hide original Gujarati' : 'View original Gujarati'}
                        className={cn(
                          'text-xs px-2 py-0.5 rounded-full border transition-colors',
                          open
                            ? 'bg-stone-100 text-stone-700 border-stone-300'
                            : 'text-stone-400 hover:text-stone-700 hover:bg-stone-50 border-transparent',
                        )}
                      >
                        {open ? '👁 hide original' : '👁 view original'}
                      </button>
                    </header>
                    {open && p.gujaratiText && (
                      <pre className="whitespace-pre-wrap text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded p-2 mb-2">
                        {p.gujaratiText}
                      </pre>
                    )}
                    <div>{renderTransliteratedBlocks(p.transliteratedText ?? '')}</div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Translation CTA — appears when transliteration is done */}
      {job.status === 'done' && (
        <div className="max-w-6xl mx-auto px-6 pb-12">
          <section className="bg-white rounded-lg border border-stone-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-stone-700">English translation (optional)</h2>
              {job.translationOutput && (
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => downloadText(`${job.filename.replace(/\.[^.]+$/, '')}-english.txt`, job.translationOutput!)}>
                    .txt
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => downloadDocx('translation')}>
                    .docx
                  </Button>
                </div>
              )}
            </div>

            {!job.translateRequested && !job.translationOutput && (
              <Button onClick={triggerTranslation} disabled={translating}>
                {translating ? 'Queueing…' : 'Translate to English'}
              </Button>
            )}
            {(job.translationStatus === 'pending' || job.translationStatus === 'running') && (
              <p className="text-stone-500 italic">
                {job.translationStatus === 'pending' ? 'Queued for translation…' : 'Translating now via local worker…'}
              </p>
            )}
            {job.translationStatus === 'failed' && (
              <p className="text-red-700">Translation failed: {job.translationError ?? 'Unknown error'}</p>
            )}
            {job.translationOutput && (
              <pre className="whitespace-pre-wrap font-serif text-stone-800 text-sm leading-relaxed max-h-[60vh] overflow-y-auto mt-2">{job.translationOutput}</pre>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
