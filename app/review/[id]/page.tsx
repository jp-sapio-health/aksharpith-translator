'use client';

import { useState, useEffect, useRef, use, Suspense } from 'react';
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

function ChunkReviewDesktop({ chunk }: { chunk: ChunkData }) {
  const sourceParas = chunk.originalGujarati.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const translationParas = chunk.translation.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius, 8px)', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid var(--border)' }}>
        <div style={{ padding: '8px 16px', borderRight: '1px solid var(--border)', background: 'var(--bg-warm)', fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)' }}>
          Gujarati Source
        </div>
        <div style={{ padding: '8px 16px', fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)' }}>
          English Translation
        </div>
      </div>
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

function ChunkReviewMobile({ chunk, showSource, onToggle }: { chunk: ChunkData; showSource: boolean; onToggle: () => void }) {
  const sourceParas = chunk.originalGujarati.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const translationParas = chunk.translation.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const scrollRef = useRef<{ source: number; translation: number }>({ source: 0, translation: 0 });

  const handleToggle = () => {
    // Save current scroll position for the active view
    scrollRef.current[showSource ? 'source' : 'translation'] = window.scrollY;
    onToggle();
  };

  useEffect(() => {
    // Restore scroll position for the view we just switched to
    window.scrollTo(0, scrollRef.current[showSource ? 'source' : 'translation']);
  }, [showSource]);

  const paras = showSource ? sourceParas : translationParas;

  return (
    <>
      <div style={{
        background: showSource ? 'var(--bg-warm)' : 'var(--bg-white)',
        padding: 16, paddingBottom: 100, minHeight: '60vh',
      }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 12 }}>
          {showSource ? 'Gujarati Source' : 'English Translation'}
        </div>
        {paras.map((p, i) => (
          <p key={i} style={{
            fontSize: showSource ? 15 : 16,
            fontFamily: showSource ? 'inherit' : '"Cormorant Garamond", serif',
            lineHeight: showSource ? 2.1 : 1.9,
            color: 'var(--text)', margin: 0,
            marginBottom: i < paras.length - 1 ? (showSource ? 20 : 16) : 0,
          }}>{p}</p>
        ))}
      </div>

      {/* Floating toggle */}
      <button
        onClick={handleToggle}
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 50,
          width: 48, height: 48, borderRadius: '50%',
          background: 'var(--text)', color: 'var(--bg-white)',
          border: 'none', cursor: 'pointer',
          boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
          fontFamily: "'Karla', sans-serif", fontSize: 10, fontWeight: 700,
          letterSpacing: '0.5px', textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {showSource ? 'EN' : 'GU'}
      </button>
    </>
  );
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return isMobile;
}

function ChunkReview({ chunk, isMobile, showSource, onToggleSource }: { chunk: ChunkData; isMobile: boolean; showSource: boolean; onToggleSource: () => void }) {
  if (isMobile) {
    return <ChunkReviewMobile chunk={chunk} showSource={showSource} onToggle={onToggleSource} />;
  }
  return <ChunkReviewDesktop chunk={chunk} />;
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
  const [showInfo, setShowInfo] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSource, setShowSource] = useState(true);
  const isMobile = useIsMobile();

  const currentChunk = Math.max(1, Number(searchParams.get('chunk')) || 1);

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
        padding: '10px 16px', position: 'sticky', top: 0, zIndex: 100,
      }}>
        {/* Top row: title + hamburger */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 300, fontSize: 18, color: 'var(--text)', letterSpacing: '-0.3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
            {fetching ? 'Loading…' : error ? 'Error' : title}
          </div>
          <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            style={{
              width: 32, height: 32, borderRadius: 6,
              border: '1px solid var(--border)', background: 'var(--bg-white)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, color: 'var(--text-light)', lineHeight: 1,
            }}
          >
            &#9776;
          </button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9 }} />
              <div style={{
                position: 'fixed', top: 56, right: 8, zIndex: 10,
                background: 'var(--bg-white)', border: '1px solid var(--border)',
                borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
                overflow: 'hidden', maxWidth: 300, width: '100%',
              }}>
                {/* Info */}
                <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', fontWeight: 300, lineHeight: 1.7 }}>
                  <div>{formatDate(doc?.createdAt ?? '')}</div>
                  <div>{doc?.inputWordCount.toLocaleString()} source · {doc?.outputWordCount.toLocaleString()} translated</div>
                  <div>by {doc?.email}</div>
                  {doc && <div style={{ marginTop: 4 }}><ScoreBadge score={doc.avgScore} /></div>}
                  {hasChunks && doc?.chunkData && (() => {
                    const chunk = doc.chunkData[Math.min(currentChunk - 1, doc.chunkData.length - 1)];
                    return chunk?.reviewerScore != null ? (
                      <div style={{ marginTop: 4 }}>Chunk: <ScoreBadge score={chunk.reviewerScore} /></div>
                    ) : null;
                  })()}
                </div>
                {/* Actions */}
                <button
                  onClick={async () => {
                    if (hasChunks && doc?.chunkData) {
                      const chunk = doc.chunkData[Math.min(currentChunk - 1, doc.chunkData.length - 1)];
                      if (chunk) await navigator.clipboard.writeText(`${chunk.originalGujarati}\n\n---\n\n${chunk.translation}`);
                    }
                    setCopied(true); setTimeout(() => setCopied(false), 2000); setMenuOpen(false);
                  }}
                  style={{ display: 'block', width: '100%', padding: '10px 16px', border: 'none', background: 'none', textAlign: 'left', fontFamily: "'Karla', sans-serif", fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  {copied ? 'Copied!' : 'Copy Chunk'}
                </button>
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(window.location.href);
                    setShareCopied(true); setTimeout(() => setShareCopied(false), 2000); setMenuOpen(false);
                  }}
                  style={{ display: 'block', width: '100%', padding: '10px 16px', border: 'none', background: 'none', textAlign: 'left', fontFamily: "'Karla', sans-serif", fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  {shareCopied ? 'Link Copied!' : 'Share Link'}
                </button>
                <div style={{ borderTop: '1px solid var(--border)' }} />
                {[
                  { label: 'Pipeline', href: '/' },
                  { label: 'History', href: '/history' },
                ].map(item => (
                  <button
                    key={item.href}
                    onClick={() => { setMenuOpen(false); router.push(item.href); }}
                    style={{
                      display: 'block', width: '100%', padding: '10px 16px',
                      border: 'none', background: 'none', textAlign: 'left',
                      fontFamily: "'Karla', sans-serif", fontSize: 13, color: 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
          </div>
        </div>

        {/* Bottom row: prev/next chunk nav */}
        {hasChunks && doc?.chunkData && doc.chunkData.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8, marginTop: 8 }}>
            <button
              onClick={() => { if (currentChunk > 1) { router.push(`/review/${id}?chunk=${currentChunk - 1}`); window.scrollTo(0, 0); } }}
              disabled={currentChunk <= 1}
              style={{
                padding: '4px 14px', border: '1px solid var(--border)', borderRadius: 6,
                background: 'var(--bg-white)', cursor: currentChunk <= 1 ? 'not-allowed' : 'pointer',
                opacity: currentChunk <= 1 ? 0.4 : 1,
                fontFamily: "'Karla', sans-serif", fontSize: 13, color: 'var(--text-light)',
              }}
            >
              ←
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300 }}>
              {currentChunk} / {doc.chunkData.length}
            </span>
            <button
              onClick={() => { if (currentChunk < doc.chunkData!.length) { router.push(`/review/${id}?chunk=${currentChunk + 1}`); window.scrollTo(0, 0); } }}
              disabled={currentChunk >= doc.chunkData.length}
              style={{
                padding: '4px 14px', border: '1px solid var(--border)', borderRadius: 6,
                background: 'var(--bg-white)', cursor: currentChunk >= doc.chunkData.length ? 'not-allowed' : 'pointer',
                opacity: currentChunk >= doc.chunkData.length ? 0.4 : 1,
                fontFamily: "'Karla', sans-serif", fontSize: 13, color: 'var(--text-light)',
              }}
            >
              →
            </button>
          </div>
        )}
      </header>

      <div style={{ padding: isMobile ? '12px 0' : '24px 20px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
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
            {/* Desktop info bar */}
            {!isMobile && (
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: 16, flexWrap: 'wrap', gap: 8,
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 300, display: 'flex', flexWrap: 'wrap', gap: '2px 14px', alignItems: 'center' }}>
                  <span>{formatDate(doc.createdAt)}</span>
                  <span>{doc.inputWordCount.toLocaleString()} source</span>
                  <span>{doc.outputWordCount.toLocaleString()} translated</span>
                  <span>by {doc.email}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ScoreBadge score={doc.avgScore} />
                  {hasChunks && doc.chunkData && (() => {
                    const chunk = doc.chunkData[Math.min(currentChunk - 1, doc.chunkData.length - 1)];
                    return chunk?.reviewerScore != null ? <ScoreBadge score={chunk.reviewerScore} /> : null;
                  })()}
                </div>
              </div>
            )}

            {/* Chunk review */}
            {(() => {
              const allChunks = hasChunks ? doc.chunkData! : [];
              const idx = Math.min(currentChunk - 1, Math.max(allChunks.length - 1, 0));
              const chunk = allChunks[idx];

              return chunk ? <ChunkReview chunk={chunk} isMobile={isMobile} showSource={showSource} onToggleSource={() => setShowSource(!showSource)} /> : null;
            })()}
          </>
        )}
      </div>
    </div>
  );
}
