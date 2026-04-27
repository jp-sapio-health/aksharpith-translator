'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../lib/auth-context';
import { useRouter } from 'next/navigation';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';

interface Translation {
  id: string;
  chapterTitle: string | null;
  bookId: string | null;
  bookTitle: string | null;
  chapterIndex: number | null;
  totalChapters: number | null;
  inputWordCount: number;
  outputWordCount: number;
  /** Reviewer telemetry — admin only when present. Not displayed in user view. */
  avgScore?: number;
  /** Translator self-flags (PR 4 contract). Surfaced inline. */
  flagsCount?: number;
  output: string;
  inputPreview: string;
  email: string;
  createdAt: string;
}

interface BookGroup {
  bookId: string;
  bookTitle: string;
  chapters: Translation[];
  totalWords: number;
  totalFlags: number;
  createdAt: string;
  email: string;
}

type HistoryItem = { type: 'book'; book: BookGroup } | { type: 'single'; translation: Translation };

function groupTranslations(translations: Translation[]): HistoryItem[] {
  const bookMap = new Map<string, Translation[]>();
  const singles: Translation[] = [];

  for (const t of translations) {
    if (t.bookId) {
      const list = bookMap.get(t.bookId) || [];
      list.push(t);
      bookMap.set(t.bookId, list);
    } else {
      singles.push(t);
    }
  }

  const items: HistoryItem[] = [];

  for (const [bookId, chapters] of bookMap) {
    chapters.sort((a, b) => (a.chapterIndex ?? 0) - (b.chapterIndex ?? 0));
    items.push({
      type: 'book',
      book: {
        bookId,
        bookTitle: chapters[0].bookTitle || 'Untitled Book',
        chapters,
        totalWords: chapters.reduce((s, c) => s + c.outputWordCount, 0),
        totalFlags: chapters.reduce((s, c) => s + (c.flagsCount ?? 0), 0),
        createdAt: chapters[0].createdAt,
        email: chapters[0].email,
      },
    });
  }

  for (const t of singles) items.push({ type: 'single', translation: t });

  items.sort((a, b) => {
    const dateA = a.type === 'book' ? a.book.createdAt : a.translation.createdAt;
    const dateB = b.type === 'book' ? b.book.createdAt : b.translation.createdAt;
    return dateB.localeCompare(dateA);
  });

  return items;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
         d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function HistoryPage() {
  const { user, loading, getIdToken } = useAuth();
  const router = useRouter();
  const [translations, setTranslations] = useState<Translation[]>([]);
  const [fetching, setFetching] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedChapterId, setExpandedChapterId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  const fetchHistory = useCallback(async (cursor?: string) => {
    const token = await getIdToken();
    if (!token) return;
    try {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/history?${params}`, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      if (data.translations) {
        setTranslations(prev => cursor ? [...prev, ...data.translations] : data.translations);
        setNextCursor(data.nextCursor ?? null);
      } else if (data.error) {
        setError(data.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history');
    } finally {
      setFetching(false);
      setLoadingMore(false);
    }
  }, [getIdToken]);

  useEffect(() => { if (user) fetchHistory(); }, [user, fetchHistory]);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    await fetchHistory(nextCursor);
  };

  const handleCopy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleDownloadSingle = (t: Translation) => {
    const blob = new Blob([t.output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const name = t.chapterTitle ? t.chapterTitle.replace(/[^a-zA-Z0-9]/g, '-') : `translation-${t.id.slice(0, 6)}`;
    const a = Object.assign(document.createElement('a'), { href: url, download: `${name}-en.txt` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadBook = (book: BookGroup) => {
    const fullText = book.chapters.map(c => c.output).join('\n\n');
    const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const name = book.bookTitle.replace(/[^a-zA-Z0-9]/g, '-').replace(/\.[^.]+$/, '');
    const a = Object.assign(document.createElement('a'), { href: url, download: `${name}-en.txt` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this translation? This cannot be undone.')) return;
    setDeleting(id);
    try {
      const token = await getIdToken();
      const res = await fetch('/api/history', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ id }),
      });
      if (res.ok) setTranslations(prev => prev.filter(t => t.id !== id));
    } catch { /* ignore */ }
    setDeleting(null);
  };

  const handleDeleteBook = async (book: BookGroup) => {
    if (!confirm(`Delete all ${book.chapters.length} chapters of "${book.bookTitle}"? This cannot be undone.`)) return;
    setDeleting(book.bookId);
    try {
      const token = await getIdToken();
      for (const ch of book.chapters) {
        await fetch('/api/history', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ id: ch.id }),
        });
      }
      setTranslations(prev => prev.filter(t => t.bookId !== book.bookId));
    } catch { /* ignore */ }
    setDeleting(null);
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="font-serif italic text-xl text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const items = groupTranslations(translations);

  /** Inline pill: 0 flags = green, 1–2 = amber, 3+ = orange. Mirrors page.tsx. */
  const flagPill = (count: number | undefined) => {
    const c = count ?? 0;
    const tone =
      c === 0 ? 'bg-[oklch(0.94_0.04_145)] text-[oklch(0.40_0.10_145)] border-[oklch(0.85_0.04_145)]' :
      c <= 2 ? 'bg-[oklch(0.95_0.04_75)] text-[oklch(0.40_0.11_75)] border-[oklch(0.86_0.04_75)]' :
      'bg-[oklch(0.95_0.04_45)] text-[oklch(0.42_0.13_45)] border-[oklch(0.85_0.05_45)]';
    return (
      <span className={cn('inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider', tone)}>
        {c === 0 ? 'no flags' : `${c} flag${c === 1 ? '' : 's'}`}
      </span>
    );
  };

  const renderChapterCard = (t: Translation) => {
    const isChExpanded = expandedChapterId === t.id;
    return (
      <div key={t.id} className="rounded-md border bg-background overflow-hidden">
        <button
          type="button"
          onClick={() => setExpandedChapterId(isChExpanded ? null : t.id)}
          className="w-full text-left px-3 py-3 sm:px-4 min-h-[48px] flex items-center justify-between gap-2 hover:bg-paper-warm transition-colors"
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm text-foreground truncate">
              {t.chapterIndex != null ? `${String(t.chapterIndex + 1).padStart(2, '0')}. ` : ''}{t.chapterTitle || 'Untitled'}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
              {t.outputWordCount.toLocaleString()} words
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {flagPill(t.flagsCount)}
            <span className={cn('text-xs text-muted-foreground transition-transform', isChExpanded && 'rotate-180')}>▾</span>
          </div>
        </button>
        {isChExpanded && (
          <div className="border-t px-3 py-3 sm:px-4">
            <div className="rounded-md border bg-paper p-3 sm:p-4 font-serif text-[15px] leading-[1.8] text-foreground whitespace-pre-wrap max-h-72 overflow-auto">
              {t.output}
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider" onClick={() => handleCopy(t.id, t.output)}>
                {copied === t.id ? 'Copied' : 'Copy'}
              </Button>
              <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider" onClick={() => handleDownloadSingle(t)}>
                Download
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-paper/95 backdrop-blur border-b">
        <div className="mx-auto max-w-3xl px-4 sm:px-5 py-3 flex items-center justify-between">
          <div className="font-serif text-xl text-foreground">
            Translation <em className="italic font-normal">History</em>
          </div>
          <div className="relative">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setHistoryMenuOpen(!historyMenuOpen)}
              aria-label="Open menu"
              className="min-h-[44px] min-w-[44px]"
            >
              <span aria-hidden className="text-base">☰</span>
            </Button>
            {historyMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setHistoryMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 top-12 z-20 min-w-[180px] rounded-md border bg-popover shadow-md overflow-hidden">
                  <button
                    type="button"
                    onClick={() => { setHistoryMenuOpen(false); router.push('/'); }}
                    className="block w-full text-left px-3 py-3 min-h-[44px] text-sm hover:bg-accent transition-colors"
                  >
                    Pipeline
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 sm:px-5 py-4 sm:py-6">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
            {error}
          </div>
        )}

        {fetching ? (
          <div className="text-center py-12">
            <div className="font-serif italic text-xl text-muted-foreground">Loading translations…</div>
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12">
            <div className="font-serif italic text-xl text-muted-foreground">No translations yet</div>
            <p className="text-sm text-muted-foreground/70 mt-2">
              Run the translation pipeline to see results here.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-xs text-muted-foreground mb-1 tabular-nums">
              {items.length} item{items.length !== 1 ? 's' : ''} · {translations.length} translation{translations.length !== 1 ? 's' : ''}
            </div>

            {items.map(item => {
              if (item.type === 'single') {
                const t = item.translation;
                const isExpanded = expandedId === t.id;
                return (
                  <div key={t.id} className="rounded-md border bg-paper overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : t.id)}
                      className="w-full text-left px-3 py-3 sm:px-4 min-h-[48px] hover:bg-paper-warm transition-colors"
                    >
                      <div className="font-serif text-base sm:text-lg text-foreground leading-snug mb-1.5 break-words">
                        {t.chapterTitle || 'Untitled Translation'}
                      </div>
                      <div className="flex items-center flex-wrap gap-2">
                        {flagPill(t.flagsCount)}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); router.push(`/review/${t.id}`); }}
                          className="ml-auto min-h-[40px] sm:min-h-0 px-3 text-muted-foreground"
                        >
                          →
                        </Button>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1.5 tabular-nums">
                        {formatDate(t.createdAt)} · {t.outputWordCount.toLocaleString()} words · {t.email}
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="border-t px-3 py-3 sm:px-4">
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider" onClick={() => router.push(`/review/${t.id}`)}>Review</Button>
                          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider" onClick={() => handleCopy(t.id, t.output)}>
                            {copied === t.id ? 'Copied' : 'Copy'}
                          </Button>
                          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider" onClick={() => handleDownloadSingle(t)}>Download</Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-[44px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider border-destructive/40 text-destructive hover:bg-destructive/5"
                            onClick={() => handleDelete(t.id)}
                            disabled={deleting === t.id}
                          >
                            {deleting === t.id ? 'Deleting…' : 'Delete'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              const book = item.book;
              const isBookExpanded = expandedId === book.bookId;
              return (
                <div key={book.bookId} className="rounded-md border bg-paper overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedId(isBookExpanded ? null : book.bookId)}
                    className="w-full text-left px-3 py-3 sm:px-4 min-h-[48px] hover:bg-paper-warm transition-colors"
                  >
                    <div className="font-serif text-base sm:text-lg text-foreground leading-snug mb-1.5 break-words">
                      {book.bookTitle}
                    </div>
                    <div className="flex items-center flex-wrap gap-2">
                      {flagPill(book.totalFlags)}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); router.push(`/review/${book.chapters[0]?.id ?? ''}`); }}
                        className="ml-auto min-h-[40px] sm:min-h-0 px-3 text-muted-foreground"
                      >
                        →
                      </Button>
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-1.5 tabular-nums">
                      {formatDate(book.createdAt)} · {book.chapters.length} chapters · {book.totalWords.toLocaleString()} words · {book.email}
                    </div>
                  </button>
                  {isBookExpanded && (
                    <div className="border-t px-3 py-3 sm:px-4 space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider" onClick={() => router.push(`/review/${book.chapters[0]?.id ?? ''}`)}>Review</Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-[44px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider"
                          onClick={() => handleCopy(book.bookId, book.chapters.map(c => c.output).join('\n\n'))}
                        >
                          {copied === book.bookId ? 'Copied' : 'Copy book'}
                        </Button>
                        <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider" onClick={() => handleDownloadBook(book)}>Download</Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-[44px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider border-destructive/40 text-destructive hover:bg-destructive/5"
                          onClick={() => handleDeleteBook(book)}
                          disabled={deleting === book.bookId}
                        >
                          {deleting === book.bookId ? 'Deleting…' : 'Delete'}
                        </Button>
                      </div>
                      <div className="space-y-2">
                        {book.chapters.map(renderChapterCard)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {nextCursor && (
              <Button
                variant="outline"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="w-full min-h-[48px] mt-2 font-mono text-[11px] uppercase tracking-wider"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
