'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../lib/auth-context';
import { useRouter } from 'next/navigation';

interface Translation {
  id: string;
  chapterTitle: string | null;
  bookId: string | null;
  bookTitle: string | null;
  chapterIndex: number | null;
  totalChapters: number | null;
  inputWordCount: number;
  outputWordCount: number;
  avgScore: number;
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
  avgScore: number;
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
    const totalWords = chapters.reduce((s, c) => s + c.outputWordCount, 0);
    const avgScore = Math.round(chapters.reduce((s, c) => s + c.avgScore, 0) / chapters.length);
    items.push({
      type: 'book',
      book: {
        bookId,
        bookTitle: chapters[0].bookTitle || 'Untitled Book',
        chapters,
        totalWords,
        avgScore,
        createdAt: chapters[0].createdAt,
        email: chapters[0].email,
      },
    });
  }

  for (const t of singles) {
    items.push({ type: 'single', translation: t });
  }

  items.sort((a, b) => {
    const dateA = a.type === 'book' ? a.book.createdAt : a.translation.createdAt;
    const dateB = b.type === 'book' ? b.book.createdAt : b.translation.createdAt;
    return dateB.localeCompare(dateA);
  });

  return items;
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

  useEffect(() => {
    if (user) fetchHistory();
  }, [user, fetchHistory]);

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
      if (res.ok) {
        setTranslations(prev => prev.filter(t => t.id !== id));
      }
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
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 20, color: 'var(--text-muted)', fontStyle: 'italic' }}>Loading…</div>
      </div>
    );
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };

  const scoreBadge = (score: number) => {
    const tier = score >= 90 ? { label: 'Publication Ready', bg: 'var(--green-bg)', color: 'var(--green)', border: 'var(--green-border)' }
      : score >= 80 ? { label: 'Strong', bg: 'var(--green-bg)', color: 'var(--green)', border: 'var(--green-border)' }
      : score >= 70 ? { label: 'Revised', bg: 'var(--amber-bg)', color: 'var(--amber)', border: 'var(--amber-border)' }
      : { label: 'Needs Work', bg: 'var(--amber-bg)', color: 'var(--amber)', border: 'var(--amber-border)' };
    return (
      <span style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.8px', textTransform: 'uppercase',
        padding: '3px 10px', borderRadius: 3,
        background: tier.bg, color: tier.color, border: `1px solid ${tier.border}`,
      }}>
        {score}% · {tier.label}
      </span>
    );
  };

  const items = groupTranslations(translations);

  const renderChapterCard = (t: Translation) => {
    const isChExpanded = expandedChapterId === t.id;
    return (
      <div key={t.id} style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--bg)' }}>
        <div
          onClick={() => setExpandedChapterId(isChExpanded ? null : t.id)}
          style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 400, color: 'var(--text)' }}>
              {t.chapterIndex != null ? `${String(t.chapterIndex + 1).padStart(2, '0')}. ` : ''}{t.chapterTitle || 'Untitled'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, fontWeight: 300 }}>
              {t.outputWordCount.toLocaleString()} words
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {scoreBadge(t.avgScore)}
            <span style={{ fontSize: 12, color: 'var(--text-light)', transform: isChExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▾</span>
          </div>
        </div>
        {isChExpanded && (
          <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
            <div style={{
              background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 6, padding: 14,
              fontFamily: '"Cormorant Garamond", serif', fontSize: 15, lineHeight: 1.8,
              color: 'var(--text-body, var(--text))', whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto',
            }}>
              {t.output}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={() => handleCopy(t.id, t.output)} style={{ padding: '6px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-white)', color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif", fontSize: 10, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer' }}>
                {copied === t.id ? 'Copied' : 'Copy'}
              </button>
              <button onClick={() => handleDownloadSingle(t)} style={{ padding: '6px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-white)', color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif", fontSize: 10, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer' }}>
                Download
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <header style={{ background: 'var(--bg-white)', borderBottom: '1px solid var(--border)', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 3, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 2 }}>
            BAPS Swaminarayan · Aksharpith
          </div>
          <div style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 300, fontSize: 26, color: 'var(--text)', letterSpacing: '-0.3px' }}>
            Translation <em>History</em>
          </div>
        </div>
        <button onClick={() => router.push('/')} style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-light)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontFamily: "'Karla', sans-serif" }}>
          Back to Pipeline
        </button>
      </header>

      <div style={{ padding: '24px 20px', maxWidth: 780, margin: '0 auto', width: '100%' }}>
        {error && (
          <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 8, padding: '14px 18px', fontSize: 13, color: 'var(--red)', marginBottom: 20 }}>
            {error}
          </div>
        )}

        {fetching ? (
          <div style={{ textAlign: 'center', padding: '48px 20px' }}>
            <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 20, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Loading translations…
            </div>
          </div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 20px' }}>
            <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 20, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No translations yet
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-light)', marginTop: 8 }}>
              Run the translation pipeline to see results here.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 4 }}>
              {items.length} item{items.length !== 1 ? 's' : ''} · {translations.length} translation{translations.length !== 1 ? 's' : ''}
            </div>

            {items.map(item => {
              if (item.type === 'single') {
                const t = item.translation;
                const isExpanded2 = expandedId === t.id;
                return (
                  <div key={t.id} style={{ background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 'var(--radius, 8px)', overflow: 'hidden' }}>
                    <div onClick={() => setExpandedId(isExpanded2 ? null : t.id)} style={{ padding: '16px 20px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 18, fontWeight: 400, color: 'var(--text)' }}>
                          {t.chapterTitle || 'Untitled Translation'}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, fontWeight: 300 }}>
                          {formatDate(t.createdAt)} · {t.outputWordCount.toLocaleString()} words · by {t.email}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {scoreBadge(t.avgScore)}
                        <span style={{ fontSize: 14, color: 'var(--text-light)', transform: isExpanded2 ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▾</span>
                      </div>
                    </div>
                    {isExpanded2 && (
                      <div style={{ borderTop: '1px solid var(--border)', padding: '16px 20px' }}>
                        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 8 }}>Source Preview</div>
                        <div style={{ fontSize: 14, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 16, lineHeight: 1.6 }}>{t.inputPreview}…</div>
                        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 8 }}>Translation</div>
                        <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 16, fontFamily: '"Cormorant Garamond", serif', fontSize: 16, lineHeight: 1.8, color: 'var(--text-body, var(--text))', whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>
                          {t.output}
                        </div>
                        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                          <button onClick={() => router.push(`/?view=${t.id}`)} style={{ padding: '8px 16px', border: '1px solid var(--text)', borderRadius: 6, background: 'var(--text)', color: 'var(--bg-white)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer' }}>
                            Open
                          </button>
                          <button onClick={() => router.push(`/review/${t.id}`)} style={{ padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-white)', color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer' }}>
                            Review
                          </button>
                          <button onClick={() => handleCopy(t.id, t.output)} style={{ padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-white)', color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer' }}>
                            {copied === t.id ? 'Copied' : 'Copy'}
                          </button>
                          <button onClick={() => handleDownloadSingle(t)} style={{ padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-white)', color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer' }}>
                            Download .txt
                          </button>
                          <button onClick={() => handleDelete(t.id)} disabled={deleting === t.id} style={{ padding: '8px 16px', border: '1px solid var(--red-border)', borderRadius: 6, background: 'var(--red-bg)', color: 'var(--red)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer', marginLeft: 'auto' }}>
                            {deleting === t.id ? 'Deleting\u2026' : 'Delete'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              // Book group
              const book = item.book;
              const isBookExpanded = expandedId === book.bookId;
              return (
                <div key={book.bookId} style={{ background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 'var(--radius, 8px)', overflow: 'hidden' }}>
                  <div onClick={() => setExpandedId(isBookExpanded ? null : book.bookId)} style={{ padding: '16px 20px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 18, fontWeight: 400, color: 'var(--text)' }}>
                          {book.bookTitle}
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.8px', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 3, background: 'var(--bg-warm)', color: 'var(--text-light)', border: '1px solid var(--border)' }}>
                          {book.chapters.length} chapters
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, fontWeight: 300 }}>
                        {formatDate(book.createdAt)} · {book.totalWords.toLocaleString()} words total · by {book.email}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {scoreBadge(book.avgScore)}
                      <span style={{ fontSize: 14, color: 'var(--text-light)', transform: isBookExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▾</span>
                    </div>
                  </div>
                  {isBookExpanded && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '16px 20px' }}>
                      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                        <button
                          onClick={() => router.push(`/?view=${book.chapters[0]?.id ?? ''}&book=${book.bookId}`)}
                          style={{ padding: '8px 16px', border: '1px solid var(--text)', borderRadius: 6, background: 'var(--text)', color: 'var(--bg-white)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer' }}
                        >
                          Open
                        </button>
                        <button
                          onClick={() => router.push(`/review/${book.chapters[0]?.id ?? ''}`)}
                          style={{ padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-white)', color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer' }}
                        >
                          Review
                        </button>
                        <button
                          onClick={() => handleCopy(book.bookId, book.chapters.map(c => c.output).join('\n\n'))}
                          style={{ padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-white)', color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer' }}
                        >
                          {copied === book.bookId ? 'Copied' : 'Copy Full Book'}
                        </button>
                        <button
                          onClick={() => handleDownloadBook(book)}
                          style={{ padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-white)', color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer' }}
                        >
                          Download Full Book .txt
                        </button>
                        <button
                          onClick={() => handleDeleteBook(book)}
                          disabled={deleting === book.bookId}
                          style={{ padding: '8px 16px', border: '1px solid var(--red-border)', borderRadius: 6, background: 'var(--red-bg)', color: 'var(--red)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer', marginLeft: 'auto' }}
                        >
                          {deleting === book.bookId ? 'Deleting\u2026' : 'Delete Book'}
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {book.chapters.map(renderChapterCard)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {nextCursor && (
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                style={{
                  width: '100%', padding: '14px 24px', marginTop: 8,
                  border: '1px solid var(--border)', borderRadius: 'var(--radius, 8px)',
                  background: 'var(--bg-white)', color: 'var(--text-muted)',
                  fontFamily: "'Karla', sans-serif", fontSize: 12, fontWeight: 600,
                  letterSpacing: '1px', textTransform: 'uppercase',
                  cursor: loadingMore ? 'not-allowed' : 'pointer',
                  opacity: loadingMore ? 0.6 : 1,
                }}
              >
                {loadingMore ? 'Loading...' : 'Load More'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
