'use client';

import { useState, useEffect, useRef, use, Suspense } from 'react';
import { useAuth } from '../../../lib/auth-context';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';

interface ChunkData {
  index: number;
  originalGujarati: string;
  translation: string;
  /** Translator self-flags — surfaced in user view (PR 4 contract). */
  flags?: string[];
  /** Reviewer telemetry — admin only when present, not displayed in user view. */
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
  output: string;
  inputPreview: string;
  email: string;
  createdAt: string;
  flagsCount?: number;
  chunkData?: ChunkData[];
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
         d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Self-flag pill: 0 = green, 1–2 = amber, 3+ = orange. */
function FlagPill({ count }: { count: number }) {
  const tone =
    count === 0 ? 'bg-[oklch(0.94_0.04_145)] text-[oklch(0.40_0.10_145)] border-[oklch(0.85_0.04_145)]' :
    count <= 2 ? 'bg-[oklch(0.95_0.04_75)] text-[oklch(0.40_0.11_75)] border-[oklch(0.86_0.04_75)]' :
    'bg-[oklch(0.95_0.04_45)] text-[oklch(0.42_0.13_45)] border-[oklch(0.85_0.05_45)]';
  return (
    <span className={cn('inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider', tone)}>
      {count === 0 ? 'no flags' : `${count} flag${count === 1 ? '' : 's'}`}
    </span>
  );
}

function ChunkReviewDesktop({ chunk }: { chunk: ChunkData }) {
  const sourceParas = chunk.originalGujarati.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const translationParas = chunk.translation.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  return (
    <div className="rounded-md border overflow-hidden">
      <div className="grid grid-cols-2 border-b bg-paper-warm/40">
        <div className="px-4 py-2 border-r font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Gujarati Source
        </div>
        <div className="px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          English Translation
        </div>
      </div>
      <div className="grid grid-cols-2 max-h-[600px]">
        <div className="overflow-y-auto p-4 pb-[400px] bg-paper-warm/30 border-r">
          {sourceParas.map((p, i) => (
            <p key={i} className={cn('text-[15px] leading-[2.1] text-foreground m-0', i < sourceParas.length - 1 && 'mb-5')}>
              {p}
            </p>
          ))}
        </div>
        <div className="overflow-y-auto p-4 pb-[400px]">
          {translationParas.map((p, i) => (
            <p key={i} className={cn('font-serif text-[16px] leading-[1.9] text-foreground m-0', i < translationParas.length - 1 && 'mb-4')}>
              {p}
            </p>
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
    scrollRef.current[showSource ? 'source' : 'translation'] = window.scrollY;
    onToggle();
  };

  useEffect(() => {
    window.scrollTo(0, scrollRef.current[showSource ? 'source' : 'translation']);
  }, [showSource]);

  const paras = showSource ? sourceParas : translationParas;

  return (
    <>
      <div className={cn('p-4 pb-24 min-h-[60vh]', showSource ? 'bg-paper-warm/40' : 'bg-paper')}>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-3">
          {showSource ? 'Gujarati Source' : 'English Translation'}
        </div>
        {paras.map((p, i) => (
          <p
            key={i}
            className={cn(
              'text-foreground m-0',
              showSource ? 'text-[15px] leading-[2.1]' : 'font-serif text-[16px] leading-[1.9]',
              i < paras.length - 1 && (showSource ? 'mb-5' : 'mb-4'),
            )}
          >
            {p}
          </p>
        ))}
      </div>

      {/* Floating toggle — ≥48px touch target */}
      <button
        type="button"
        onClick={handleToggle}
        aria-label={showSource ? 'Show English' : 'Show Gujarati'}
        className="fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full bg-foreground text-background shadow-lg font-mono text-[11px] font-bold tracking-wider flex items-center justify-center"
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

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="font-serif italic text-xl text-muted-foreground">Loading…</div>
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
        if (!res.ok) {
          setError(res.status === 404 ? 'Translation not found' : `Error ${res.status}`);
          return;
        }
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
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="font-serif italic text-xl text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const title = doc?.bookTitle
    ? `${doc.bookTitle}${doc.chapterTitle ? ` — ${doc.chapterTitle}` : ''}`
    : doc?.chapterTitle || 'Translation Review';

  const hasChunks = doc?.chunkData && doc.chunkData.length > 0;
  const currentChunkData = hasChunks && doc?.chunkData
    ? doc.chunkData[Math.min(currentChunk - 1, doc.chunkData.length - 1)]
    : null;
  const currentFlags = currentChunkData?.flags ?? [];

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-paper/95 backdrop-blur border-b">
        <div className="px-4 sm:px-5 py-3 mx-auto max-w-5xl">
          <div className="flex items-center justify-between gap-2">
            <div className="font-serif text-lg text-foreground truncate flex-1 min-w-0">
              {fetching ? 'Loading…' : error ? 'Error' : title}
            </div>
            <div className="relative shrink-0">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMenuOpen(!menuOpen)}
                aria-label="Open menu"
                className="min-h-[44px] min-w-[44px]"
              >
                <span aria-hidden className="text-base">☰</span>
              </Button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
                  <div className="absolute right-0 top-12 z-20 max-w-[300px] w-[calc(100vw-32px)] rounded-md border bg-popover shadow-md overflow-hidden">
                    <div className="px-3 py-2.5 border-b text-xs text-muted-foreground space-y-0.5">
                      <div>{formatDate(doc?.createdAt ?? '')}</div>
                      <div className="tabular-nums">
                        {doc?.inputWordCount.toLocaleString()} source · {doc?.outputWordCount.toLocaleString()} translated
                      </div>
                      <div>by {doc?.email}</div>
                      {currentChunkData && (
                        <div className="pt-1.5">
                          <FlagPill count={currentFlags.length} />
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        if (currentChunkData) {
                          await navigator.clipboard.writeText(`${currentChunkData.originalGujarati}\n\n---\n\n${currentChunkData.translation}`);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }
                        setMenuOpen(false);
                      }}
                      className="block w-full text-left px-3 py-3 min-h-[44px] text-sm hover:bg-accent transition-colors"
                    >
                      {copied ? 'Copied!' : 'Copy chunk'}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(window.location.href);
                        setShareCopied(true);
                        setTimeout(() => setShareCopied(false), 2000);
                        setMenuOpen(false);
                      }}
                      className="block w-full text-left px-3 py-3 min-h-[44px] text-sm hover:bg-accent transition-colors"
                    >
                      {shareCopied ? 'Link copied!' : 'Share link'}
                    </button>
                    <div className="border-t" />
                    {[
                      { label: 'Pipeline', href: '/' },
                      { label: 'History', href: '/history' },
                    ].map(item => (
                      <button
                        key={item.href}
                        type="button"
                        onClick={() => { setMenuOpen(false); router.push(item.href); }}
                        className="block w-full text-left px-3 py-3 min-h-[44px] text-sm hover:bg-accent transition-colors"
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {hasChunks && doc?.chunkData && doc.chunkData.length > 1 && (
            <div className="flex items-center gap-2 mt-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-[40px] sm:min-h-0 px-3"
                onClick={() => { if (currentChunk > 1) { router.push(`/review/${id}?chunk=${currentChunk - 1}`); window.scrollTo(0, 0); } }}
                disabled={currentChunk <= 1}
              >
                ←
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                {currentChunk} / {doc.chunkData.length}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="min-h-[40px] sm:min-h-0 px-3"
                onClick={() => { if (currentChunk < doc.chunkData!.length) { router.push(`/review/${id}?chunk=${currentChunk + 1}`); window.scrollTo(0, 0); } }}
                disabled={currentChunk >= doc.chunkData.length}
              >
                →
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className={cn('mx-auto w-full max-w-6xl', isMobile ? 'px-0 py-3' : 'px-5 py-6')}>
        {error && (
          <div className="mb-4 mx-4 sm:mx-0 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
            {error}
          </div>
        )}

        {fetching ? (
          <div className="text-center py-12">
            <div className="font-serif italic text-xl text-muted-foreground">Loading translation…</div>
          </div>
        ) : doc && (
          <>
            {!isMobile && (
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                  <span>{formatDate(doc.createdAt)}</span>
                  <span>{doc.inputWordCount.toLocaleString()} source</span>
                  <span>{doc.outputWordCount.toLocaleString()} translated</span>
                  <span>by {doc.email}</span>
                </div>
                {currentChunkData && <FlagPill count={currentFlags.length} />}
              </div>
            )}

            {/* Self-flags inline panel for the current chunk */}
            {currentFlags.length > 0 && (
              <div className="mx-4 sm:mx-0 mb-3 rounded-md border bg-paper-warm/60 px-3 py-2.5">
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
                  Translator self-flags
                </div>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {currentFlags.map((f, i) => (
                    <li key={i} className="leading-relaxed">• {f}</li>
                  ))}
                </ul>
              </div>
            )}

            {currentChunkData && (
              isMobile
                ? <ChunkReviewMobile chunk={currentChunkData} showSource={showSource} onToggle={() => setShowSource(!showSource)} />
                : <ChunkReviewDesktop chunk={currentChunkData} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
