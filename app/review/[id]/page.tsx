'use client';

import { useState, useEffect, use, Suspense } from 'react';
import { useAuth } from '../../../lib/auth-context';
import { useRouter, useSearchParams } from 'next/navigation';

interface ChunkData {
  index: number;
  originalGujarati: string;
  translation: string;
  reviewerScore?: number;
  certifiable?: boolean;
  reviewerCategories?: Array<{ id: string; score: number; weight: number }>;
}

interface TranslationDoc {
  id: string;
  chapterTitle: string | null;
  bookTitle: string | null;
  bookId: string | null;
  chapterIndex: number | null;
  totalChapters: number | null;
  inputWordCount: number;
  outputWordCount: number;
  avgScore: number;
  output: string;
  inputPreview: string;
  email: string;
  createdAt: string;
  chunkData?: ChunkData[];
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
         d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function ScoreBadge({ score }: { score: number }) {
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
}

function ChunkReview({ chunk, index, total }: { chunk: ChunkData; index: number; total: number }) {
  const sourceParas = chunk.originalGujarati.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const translationParas = chunk.translation.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius, 8px)', overflow: 'hidden' }}>
      {/* Chunk header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 16px', background: 'var(--bg)', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 13, color: 'var(--text-light)', letterSpacing: 1 }}>
            Chunk {index + 1} of {total}
          </span>
          {chunk.certifiable && (
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--green)' }}>Certified</span>
          )}
        </div>
        {chunk.reviewerScore != null && <ScoreBadge score={chunk.reviewerScore} />}
      </div>

      {/* Column headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid var(--border)' }}>
        <div style={{ padding: '8px 16px', borderRight: '1px solid var(--border)', background: 'var(--bg-warm)', fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)' }}>
          Gujarati Source
        </div>
        <div style={{ padding: '8px 16px', fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)' }}>
          English Translation
        </div>
      </div>

      {/* Two independently scrollable columns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', maxHeight: 600 }}>
        <div style={{ borderRight: '1px solid var(--border)', background: 'var(--bg-warm)', overflowY: 'auto', padding: 16, paddingBottom: 400, maxHeight: 600 }}>
          {sourceParas.map((p, i) => (
            <p key={i} style={{ fontSize: 15, lineHeight: 2.1, color: 'var(--text)', margin: 0, marginBottom: i < sourceParas.length - 1 ? 20 : 0 }}>{p}</p>
          ))}
        </div>
        <div style={{ overflowY: 'auto', padding: 16, paddingBottom: 400, maxHeight: 600 }}>
          {translationParas.map((p, i) => (
            <p key={i} style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 16, lineHeight: 1.9, color: 'var(--text)', margin: 0, marginBottom: i < translationParas.length - 1 ? 16 : 0 }}>{p}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 20, color: 'var(--text-muted)', fontStyle: 'italic' }}>Loading…</div>
      </div>
    }>
      <ReviewPageInner params={params} />
    </Suspense>
  );
}

function ReviewPageInner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading, getIdToken } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [doc, setDoc] = useState<TranslationDoc | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const CHUNKS_PER_PAGE = 10;
  const currentPage = Math.max(1, Number(searchParams.get('page')) || 1);

  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const token = await getIdToken();
      if (!token) return;
      try {
        const res = await fetch(`/api/translations/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) { setError(res.status === 404 ? 'Translation not found' : `Error ${res.status}`); return; }
        setDoc(await res.json());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setFetching(false);
      }
    })();
  }, [user, id, getIdToken]);

  if (loading || !user) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 20, color: 'var(--text-muted)', fontStyle: 'italic' }}>Loading…</div>
      </div>
    );
  }

  const title = doc?.bookTitle
    ? `${doc.bookTitle}${doc.chapterTitle ? ` — ${doc.chapterTitle}` : ''}`
    : doc?.chapterTitle || 'Translation Review';

  const hasChunks = doc?.chunkData && doc.chunkData.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* Header */}
      <header style={{
        background: 'var(--bg-white)', borderBottom: '1px solid var(--border)',
        padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 3, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 2 }}>
            Translation Review
          </div>
          <div style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 300, fontSize: 22, color: 'var(--text)', letterSpacing: '-0.3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {fetching ? 'Loading…' : error ? 'Error' : title}
          </div>
        </div>
        <button onClick={() => router.push('/history')} style={{
          fontSize: 11, fontWeight: 500, color: 'var(--text-light)', background: 'none',
          border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px',
          cursor: 'pointer', fontFamily: "'Karla', sans-serif",
        }}>
          Back
        </button>
      </header>

      <div style={{ padding: '24px 20px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
        {error && (
          <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 8, padding: '14px 18px', fontSize: 13, color: 'var(--red)', marginBottom: 20 }}>
            {error}
          </div>
        )}

        {fetching ? (
          <div style={{ textAlign: 'center', padding: '48px 20px' }}>
            <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 20, color: 'var(--text-muted)', fontStyle: 'italic' }}>Loading translation…</div>
          </div>
        ) : doc && (
          <>
            {/* Summary bar */}
            <div style={{
              background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 'var(--radius, 8px)',
              padding: '16px 20px', marginBottom: 20,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12,
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 300, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                <span>{formatDate(doc.createdAt)}</span>
                <span>{doc.inputWordCount.toLocaleString()} source words</span>
                <span>{doc.outputWordCount.toLocaleString()} translated words</span>
                {hasChunks && <span>{doc.chunkData!.length} chunks</span>}
                <span>by {doc.email}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ScoreBadge score={doc.avgScore} />
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(doc.output);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  style={{
                    padding: '5px 12px', border: '1px solid var(--border)', borderRadius: 6,
                    background: 'var(--bg-white)', color: 'var(--text-muted)',
                    fontFamily: "'Karla', sans-serif", fontSize: 10, fontWeight: 600,
                    letterSpacing: '0.8px', textTransform: 'uppercase', cursor: 'pointer',
                  }}
                >
                  {copied ? 'Copied' : 'Copy All'}
                </button>
              </div>
            </div>

            {/* Chunk-by-chunk review */}
            {hasChunks ? (() => {
              const allChunks = doc.chunkData!;
              const totalPages = Math.ceil(allChunks.length / CHUNKS_PER_PAGE);
              const startIdx = (currentPage - 1) * CHUNKS_PER_PAGE;
              const pageChunks = allChunks.slice(startIdx, startIdx + CHUNKS_PER_PAGE);
              const goToPage = (p: number) => router.push(`/review/${id}?page=${p}`);

              const navBar = totalPages > 1 && (
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 0',
                }}>
                  <button
                    onClick={() => goToPage(currentPage - 1)}
                    disabled={currentPage <= 1}
                    style={{
                      padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6,
                      background: 'var(--bg-white)', color: currentPage <= 1 ? 'var(--text-light)' : 'var(--text-muted)',
                      fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600,
                      letterSpacing: '1px', textTransform: 'uppercase',
                      cursor: currentPage <= 1 ? 'not-allowed' : 'pointer',
                      opacity: currentPage <= 1 ? 0.5 : 1,
                    }}
                  >
                    Prev {CHUNKS_PER_PAGE}
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 300 }}>
                    Chunks {startIdx + 1}–{Math.min(startIdx + CHUNKS_PER_PAGE, allChunks.length)} of {allChunks.length}
                  </span>
                  <button
                    onClick={() => goToPage(currentPage + 1)}
                    disabled={currentPage >= totalPages}
                    style={{
                      padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6,
                      background: 'var(--bg-white)', color: currentPage >= totalPages ? 'var(--text-light)' : 'var(--text-muted)',
                      fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600,
                      letterSpacing: '1px', textTransform: 'uppercase',
                      cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer',
                      opacity: currentPage >= totalPages ? 0.5 : 1,
                    }}
                  >
                    Next {CHUNKS_PER_PAGE}
                  </button>
                </div>
              );

              return (
                <>
                  {navBar}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {pageChunks.map((chunk, i) => (
                      <ChunkReview key={startIdx + i} chunk={chunk} index={startIdx + i} total={allChunks.length} />
                    ))}
                  </div>
                  {navBar}
                </>
              );
            })() : (
              /* Fallback: no chunk data, show full output */
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={{
                  background: 'var(--bg-warm)', border: '1px solid var(--border)', borderRadius: 'var(--radius, 8px)',
                  padding: 20,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 10 }}>
                    Source Preview
                  </div>
                  <div style={{ fontSize: 15, lineHeight: 1.9, color: 'var(--text)' }}>
                    {doc.inputPreview}…
                  </div>
                </div>
                <div style={{
                  background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 'var(--radius, 8px)',
                  padding: 20,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 10 }}>
                    Translation
                  </div>
                  <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 16, lineHeight: 1.9, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
                    {doc.output}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
