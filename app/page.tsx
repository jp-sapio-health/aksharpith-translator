'use client';

import { useState, useRef, useCallback, useEffect, Suspense } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../lib/auth-context';
import { useRouter, useSearchParams } from 'next/navigation';
import { getFirebaseDb } from '../lib/firebase';
import { upload as blobUpload } from '@vercel/blob/client';
import OutputView from './components/OutputView';
import DocumentRenderer from './components/DocumentRenderer';
import ReviewPanel from './components/ReviewPanel';
import DownloadMenu from './components/DownloadMenu';
import QualitySummary from './components/QualitySummary';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { ActiveJobsStrip } from '../components/ActiveJobsStrip';
import { cn } from '../lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────────

type StageStatus = 'waiting' | 'running' | 'done' | 'error';
type Tab = 'input' | 'pipeline' | 'output';
type InputMode = 'paste' | 'upload';

interface StageState {
  id: 'chunker' | 'translator' | 'smoother' | 'assembler' | 'enforcer';
  num: string; label: string; tagline: string;
  status: StageStatus; msg: string; progress: number | null;
}

interface EnforcerCorrection {
  from: string; to: string; count: number;
}

// User view consumes translator self-flags. The pipeline produces no
// reviewer-derived fields after the pare-down.
interface ChunkData {
  index: number; original: string;
  translation?: string;
  flags?: string[];
}

interface ChapterResult {
  title: string; index: number; startLine: number;
  status: 'pending' | 'running' | 'done' | 'error';
  output?: string; wordCount?: number; flagsCount?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

// Pipeline view — five stages, no reviewer.
const INITIAL_STAGES: StageState[] = [
  { id: 'chunker',    num: '01', label: 'Chunker',    tagline: 'Splits text at paragraph and verse boundaries into ≤500-word segments', status: 'waiting', msg: '', progress: null },
  { id: 'translator', num: '02', label: 'Translator', tagline: 'Gujarati→English with full Aksharpith style context (Sonnet)', status: 'waiting', msg: '', progress: null },
  { id: 'smoother',   num: '03', label: 'Smoother',   tagline: 'Readability pass — preserves all BAPS terminology and direct quotes', status: 'waiting', msg: '', progress: null },
  { id: 'assembler',  num: '04', label: 'Assembler',  tagline: 'Structural join only — deduplicates boundaries, no rewrites', status: 'waiting', msg: '', progress: null },
  { id: 'enforcer',   num: '05', label: 'Rules Enforcer', tagline: 'Deterministic rules check — terminology, punctuation, diacritics, place names', status: 'waiting', msg: '', progress: null },
];

const SAMPLE = `પ્રેમે પ્રગટ્યા રે સૂરજ સહજાનંદ, અધર્મ અંધારું ટાળિયું...

ભગવાન સ્વામિનારાયણના સમકાલીન અને તેઓના જ પરમહંસ-શિષ્ય સ્વામી મુક્તાનંદજીએ ગાયેલી આ પંક્તિ, અઢારમી સદીના ઘોર દુર્ભેદ્ય અંધકારને ઉલેચનાર ભગવાન સ્વામિનારાયણને ખૂબ ઉચિત અંજલિ અર્પે છે.

સને 1781માં ત્રીજી એપ્રિલે, અયોધ્યા પાસે છપિયા ગામે ઉચ્ચ સરવરિયા બ્રાહ્મણ કુળમાં પ્રગટેલા આ અવતારી પુરુષે, બાળવયમાં જ તીવ્ર બુદ્ધિમત્તા, વિદ્વત્તા અને દિવ્યતાનો અસાધારણ અનુભવ કરાવ્યો; માત્ર 11 જ વર્ષની કુમળી વયે ગૃહત્યાગ કર્યો.`;

const MAX_WORDS  = 50000;
const WARN_WORDS = 6000;

// ── Shared styles ──────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 8,
};

function badgeStyle(type: 'strong' | 'adequate' | 'weak' | 'running'): React.CSSProperties {
  const map = {
    strong:   { bg: 'var(--green-bg)',  color: 'var(--green)',  border: 'var(--green-border)' },
    adequate: { bg: 'var(--amber-bg)',  color: 'var(--amber)',  border: 'var(--amber-border)' },
    weak:     { bg: 'var(--red-bg)',    color: 'var(--red)',    border: 'var(--red-border)' },
    running:  { bg: 'var(--amber-bg)',  color: 'var(--amber)',  border: 'var(--amber-border)' },
  };
  const t = map[type];
  return {
    fontFamily: "'Karla', sans-serif", fontSize: 10, fontWeight: 600,
    letterSpacing: '0.8px', textTransform: 'uppercase', whiteSpace: 'nowrap',
    padding: '3px 10px', borderRadius: 3,
    background: t.bg, color: t.color, border: `1px solid ${t.border}`,
  };
}

function wc(t: string) { return t.trim() ? t.trim().split(/\s+/).length : 0; }

// ── StageCard ──────────────────────────────────────────────────────────────────

function StageCard({ stage, commentary }: { stage: StageState; commentary?: string | null }) {
  const s = stage.status;
  const ringTone =
    s === 'running' ? 'border-l-[oklch(0.55_0.16_75)]' :
    s === 'done' ? 'border-l-[oklch(0.55_0.13_145)]' :
    s === 'error' ? 'border-l-destructive' :
    'border-l-border';
  const labelTone = s === 'waiting' ? 'text-muted-foreground' : 'text-foreground';
  const tagTone =
    s === 'done' ? 'text-[oklch(0.42_0.10_145)]' :
    s === 'running' ? 'text-[oklch(0.45_0.13_75)]' :
    s === 'error' ? 'text-destructive' :
    'text-muted-foreground/70';

  return (
    <div className={cn(
      'rounded-md border bg-paper border-l-4 transition-colors',
      ringTone,
    )}>
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3 sm:px-5">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70 shrink-0">
            {stage.num}
          </span>
          <span className={cn('font-serif text-lg sm:text-xl truncate', labelTone)}>
            {stage.label}
          </span>
        </div>
        <span className={cn('font-mono text-[10px] uppercase tracking-wider shrink-0', tagTone)}>
          {s === 'done' ? '✓ done' : s === 'running' ? '→ running' : s === 'error' ? '✗ error' : '·'}
        </span>
      </div>
      <p className="px-4 pb-3 sm:px-5 mt-1 pl-4 sm:pl-5 text-xs text-muted-foreground/90 leading-relaxed">
        {stage.msg || stage.tagline}
      </p>
      {s === 'running' && commentary && (
        <p className="px-4 pb-3 sm:px-5 -mt-1 text-xs italic text-muted-foreground/80 leading-relaxed">
          {commentary}
        </p>
      )}
    </div>
  );
}

// ── ChapterBar ─────────────────────────────────────────────────────────────────

function ChapterBar({ chapters }: { chapters: ChapterResult[] }) {
  if (chapters.length === 0) return null;
  return (
    <div style={{ background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '16px 20px', marginBottom: 20 }}>
      <div style={labelStyle}>Book Progress</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
        {chapters.map((ch, i) => (
          <div key={i} title={ch.title} style={{
            flex: '1 1 80px', minWidth: 60, maxWidth: 120, height: 6, borderRadius: 3,
            background: ch.status === 'done' ? 'var(--green)' : ch.status === 'running' ? 'var(--amber)' : ch.status === 'error' ? 'var(--red)' : 'var(--border)',
            transition: 'background 0.4s',
          }} />
        ))}
      </div>
      <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--text-muted)', marginTop: 8 }}>
        {chapters.filter(c => c.status === 'done').length} of {chapters.length} sections complete
      </div>
    </div>
  );
}

// ── FileUpload ─────────────────────────────────────────────────────────────────

const UPLOAD_ACCEPT = '.pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.webp,.gif';

function formatFileSize(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileTypeLabel(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = { pdf: 'PDF', docx: 'DOCX', doc: 'DOC', txt: 'TXT', png: 'PNG', jpg: 'JPG', jpeg: 'JPG', webp: 'WEBP', gif: 'GIF' };
  return map[ext] ?? ext.toUpperCase();
}

type UploadPhase = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

const EXTRACTION_STEPS: Array<{ label: string; detail: string }> = [
  { label: 'Reading document structure', detail: 'Scanning pages and identifying text layers…' },
  { label: 'Extracting text content', detail: 'Pulling text from each page while preserving Gujarati Unicode…' },
  { label: 'Detecting chapters', detail: 'Identifying chapter headings and table of contents…' },
  { label: 'Analysing structure', detail: 'Mapping paragraph boundaries, verses, and section breaks…' },
  { label: 'Preparing for translation', detail: 'Validating extracted text and building section index…' },
];

function FileUpload({ onExtracted, disabled, getToken }: { onExtracted: (text: string, filename: string, chapters: Array<{ title: string; startLine: number }> | null) => void; disabled: boolean; getToken: () => Promise<string | null> }) {
  const router = useRouter();
  const [dragging, setDragging]           = useState(false);
  const [selectedFile, setSelectedFile]   = useState<File | null>(null);
  const [phase, setPhase]                 = useState<UploadPhase>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [extractionStep, setExtractionStep] = useState(0);
  const [error, setError]                 = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef   = useRef<XMLHttpRequest | null>(null);
  const extractionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Advance extraction step captions while processing
  useEffect(() => {
    if (phase === 'processing') {
      setExtractionStep(0);
      extractionTimerRef.current = setInterval(() => {
        setExtractionStep(prev => Math.min(prev + 1, EXTRACTION_STEPS.length - 1));
      }, 4000);
      return () => { if (extractionTimerRef.current) clearInterval(extractionTimerRef.current); };
    } else {
      if (extractionTimerRef.current) clearInterval(extractionTimerRef.current);
    }
  }, [phase]);

  // Vercel serverless rejects request bodies > 4.5 MB at the platform layer
  // before the function can run. For larger files we upload directly to
  // Firebase Storage and then call the route with a JSON pointer instead of
  // multipart. The 4 MB threshold leaves headroom for multipart overhead.
  const VERCEL_BODY_LIMIT = 4 * 1024 * 1024;

  const startUpload = async (file: File) => {
    setSelectedFile(file);
    setError(null);
    setPhase('uploading');
    setUploadProgress(0);

    if (file.size > VERCEL_BODY_LIMIT) {
      await startUploadViaStorage(file);
    } else {
      startUploadViaMultipart(file);
    }
  };

  const handleResponse = async (status: number, responseText: string, fallbackFilename: string) => {
    let data: { error?: string; status?: string; extractionId?: string; jobId?: string; totalPages?: number; text?: string; filename?: string; chapters?: Array<{ title: string; startLine: number }> | null } = {};
    try { data = JSON.parse(responseText); }
    catch { setError('Failed to parse server response'); setPhase('error'); return; }

    if (status >= 400 || data.error) {
      setError(data.error ?? `Upload failed (HTTP ${status})`);
      setPhase('error');
      return;
    }

    // Transliteration-first pipeline (PDFs, page-by-page). Redirect to the
    // job view, which subscribes to Firestore for live progress.
    if (data.status === 'transliterating' && data.jobId) {
      router.push(`/transliterate/${data.jobId}`);
      return;
    }

    if (data.status === 'extracting_locally' && data.extractionId) {
      setExtractionStep(1);
      const tk = await getToken();
      const extractionId = data.extractionId;
      const filename = data.filename ?? fallbackFilename;
      const pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/extract?id=${extractionId}`, {
            headers: tk ? { Authorization: `Bearer ${tk}` } : {},
          });
          const poll = await res.json();
          if (poll.progress) setExtractionStep(prev => Math.min(prev + 1, EXTRACTION_STEPS.length - 1));
          if (poll.status === 'completed') {
            clearInterval(pollInterval);
            setPhase('done');
            onExtracted(poll.text ?? '', filename, poll.chapters ?? null);
          }
          if (poll.status === 'failed') {
            clearInterval(pollInterval);
            setError(poll.error ?? 'Extraction failed');
            setPhase('error');
          }
        } catch { /* keep polling */ }
      }, 2000);
      return;
    }

    setPhase('done');
    onExtracted(data.text ?? '', data.filename ?? fallbackFilename, data.chapters ?? null);
  };

  const startUploadViaMultipart = (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) setUploadProgress(Math.round(e.loaded / e.total * 100));
    });
    xhr.upload.addEventListener('loadend', () => setPhase('processing'));
    xhr.addEventListener('load', () => { void handleResponse(xhr.status, xhr.responseText, file.name); });
    xhr.addEventListener('error', () => { setError('Upload failed — check your connection and try again'); setPhase('error'); });
    xhr.addEventListener('timeout', () => { setError('Upload timed out — file may be too large for your connection'); setPhase('error'); });

    xhr.timeout = 300000;
    xhr.open('POST', '/api/upload');
    void getToken().then(token => {
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.send(fd);
    });
  };

  const startUploadViaStorage = async (file: File) => {
    const auth = (await import('../lib/firebase')).getFirebaseAuth();
    const uid = auth.currentUser?.uid;
    if (!uid) { setError('You must be signed in to upload'); setPhase('error'); return; }

    const safeName = file.name.replace(/[^\w.\- ]+/g, '_');
    const pathname = `uploads/${uid}/${Date.now()}_${safeName}`;

    // The Blob SDK doesn't forward auth headers, so we pass the Firebase ID
    // token through `clientPayload` and verify it on the server.
    const firebaseToken = await getToken();
    if (!firebaseToken) { setError('You must be signed in to upload'); setPhase('error'); return; }

    let blob;
    try {
      blob = await blobUpload(pathname, file, {
        access: 'public',
        handleUploadUrl: '/api/blob-token',
        contentType: file.type || 'application/octet-stream',
        clientPayload: JSON.stringify({ firebaseToken }),
        onUploadProgress: ({ percentage }) => setUploadProgress(Math.round(percentage)),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setError(`Upload failed: ${msg}`);
      setPhase('error');
      return;
    }

    setPhase('processing');
    const token = await getToken();
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ blobUrl: blob.url, filename: file.name }),
      });
      const text = await res.text();
      void handleResponse(res.status, text, file.name);
    } catch {
      setError('Server unreachable — check your connection');
      setPhase('error');
    }
  };

  const handleRetry = () => { if (selectedFile) startUpload(selectedFile); };
  const handleReset = () => {
    xhrRef.current?.abort();
    setSelectedFile(null);
    setPhase('idle');
    setError(null);
    setUploadProgress(0);
  };

  const isActive = phase !== 'idle' && phase !== 'error';

  return (
    <div>
      {/* ── Drop zone (shown when idle or error with no file) ── */}
      {(phase === 'idle' || (phase === 'error' && !selectedFile)) && (
        <div
          onClick={() => !disabled && inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) startUpload(f); }}
          style={{
            border: `2px dashed ${dragging ? 'var(--text)' : 'var(--border)'}`,
            borderRadius: 'var(--radius)', padding: '32px 24px', textAlign: 'center',
            cursor: disabled ? 'not-allowed' : 'pointer',
            background: dragging ? 'var(--bg-warm)' : 'var(--bg-white)',
            transition: 'all 0.2s', opacity: disabled ? 0.6 : 1,
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.4 }}>↑</div>
          <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 20, color: 'var(--text)' }}>Drop your file here</div>
          <div style={{ fontSize: 12, fontWeight: 300, color: 'var(--text-light)', marginTop: 6 }}>PDF · DOCX · DOC · TXT · PNG · JPG · WEBP · GIF</div>
          <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4, opacity: 0.7 }}>Up to 100 MB · entire books accepted</div>
        </div>
      )}

      {/* ── File card (shown during upload/processing/done/error-with-file) ── */}
      {selectedFile && phase !== 'idle' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }} className="fadein">
          {/* File header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--bg)', borderBottom: '1px solid var(--border-light)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
              <span style={{ ...badgeStyle(phase === 'done' ? 'strong' : phase === 'error' ? 'weak' : 'running'), flexShrink: 0 }}>
                {fileTypeLabel(selectedFile.name)}
              </span>
              <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedFile.name}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: 'var(--text-light)' }}>{formatFileSize(selectedFile.size)}</span>
              {!isActive && (
                <button onClick={handleReset} style={{ fontSize: 13, color: 'var(--text-light)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', lineHeight: 1 }}>✕</button>
              )}
            </div>
          </div>

          {/* Progress / status section */}
          <div style={{ padding: '14px 16px' }}>
            {phase === 'uploading' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>Uploading file…</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--amber)' }}>{uploadProgress}%</span>
                </div>
                <div style={{ height: 4, background: 'var(--border)', borderRadius: 2 }}>
                  <div style={{ height: '100%', background: 'var(--amber)', borderRadius: 2, width: `${uploadProgress}%`, transition: 'width 0.3s' }} />
                </div>
              </>
            )}

            {phase === 'processing' && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>
                    {EXTRACTION_STEPS[extractionStep]?.label ?? 'Processing…'}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--amber)' }}>
                    {Math.round(((extractionStep + 1) / EXTRACTION_STEPS.length) * 100)}%
                  </span>
                </div>
                <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, marginBottom: 8 }}>
                  <div style={{
                    height: '100%', background: 'var(--amber)', borderRadius: 2,
                    width: `${((extractionStep + 1) / EXTRACTION_STEPS.length) * 100}%`,
                    transition: 'width 0.6s ease',
                  }} />
                </div>
                <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--text-light)', fontStyle: 'italic' }} className="fadein" key={extractionStep}>
                  {EXTRACTION_STEPS[extractionStep]?.detail}
                </div>
              </div>
            )}

            {phase === 'done' && (
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--green)' }}>✓ Text extracted successfully</div>
            )}

            {phase === 'error' && (
              <>
                <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>{error}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={handleRetry} style={{ fontSize: 11, fontWeight: 600, color: 'var(--amber)', background: 'none', border: '1px solid var(--amber-border)', borderRadius: 4, padding: '5px 14px', cursor: 'pointer' }}>
                    Retry
                  </button>
                  <button onClick={handleReset} style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-light)', background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 14px', cursor: 'pointer' }}>
                    Choose different file
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <input ref={inputRef} type="file" accept={UPLOAD_ACCEPT} style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) startUpload(f); e.target.value = ''; }} />
    </div>
  );
}

// ── ChunkCard (PR 4: flags-driven, mobile-first) ──────────────────────────────

/**
 * Renders one chunk in the user-facing pipeline view. Reviewer scores are not
 * shown here — they're admin-only telemetry. Translator self-flags are
 * surfaced inline with a colour-coded dot:
 *   • green = 0 self-flags (translator was confident)
 *   • amber = 1–2 self-flags
 *   • orange = 3+ self-flags (expandable to read the flag text)
 */
function ChunkCard({ chunk, expanded, onToggle }: { chunk: ChunkData; expanded: boolean; onToggle: () => void }) {
  const flags = chunk.flags ?? [];
  const flagTone =
    flags.length === 0 ? 'green' :
    flags.length <= 2 ? 'amber' :
    'orange';
  const dotColor =
    flagTone === 'green' ? 'bg-[oklch(0.65_0.13_145)]' :
    flagTone === 'amber' ? 'bg-[oklch(0.75_0.14_75)]' :
    'bg-[oklch(0.62_0.18_45)]';
  const displayText = chunk.translation ?? '';

  return (
    <div className={cn(
      'rounded-md border bg-paper overflow-hidden mb-3 transition-colors',
    )}>
      {/* Header — always visible, click to toggle */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left flex items-center justify-between gap-3 px-3 py-3 sm:px-4 sm:py-3 min-h-[48px] hover:bg-paper-warm transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', dotColor)} aria-hidden />
          <span className="font-serif text-sm text-muted-foreground tracking-wide shrink-0">
            Chunk {chunk.index + 1}
          </span>
          {!expanded && displayText && (
            <span className="hidden sm:inline truncate text-sm text-muted-foreground/80 font-light">
              {displayText.slice(0, 80)}
              {displayText.length > 80 ? '…' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {flags.length === 0 ? 'no flags' : `${flags.length} flag${flags.length === 1 ? '' : 's'}`}
          </span>
          <span aria-hidden className="text-[10px]">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {/* Collapsed preview */}
      {!expanded && displayText && (
        <div className="px-3 pb-3 sm:px-4 sm:pb-3 font-serif text-[15px] leading-[1.65] text-muted-foreground italic">
          {displayText.slice(0, 200)}
          {displayText.length > 200 ? '…' : ''}
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-4 sm:px-4 sm:pb-4 space-y-4 border-t bg-background/40">
          {/* Translator self-flags */}
          {flags.length > 0 && (
            <div className="pt-3">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                Translator self-flags ({flags.length})
              </div>
              <ul className="space-y-1.5">
                {flags.map((flag, i) => (
                  <li key={i} className="flex gap-2 items-start">
                    <span className={cn('h-1.5 w-1.5 rounded-full mt-2 shrink-0', dotColor)} aria-hidden />
                    <span className="text-sm font-light text-muted-foreground leading-[1.55]">{flag}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted-foreground/70 leading-relaxed">
                Flags are spans the translator was not fully confident about. They are not quality scores —
                review them against the source if anything looks off.
              </p>
            </div>
          )}

          {/* Final translation */}
          {displayText && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                Translation
              </div>
              <div className="rounded-md border border-border/60 bg-background px-3 py-3 sm:px-4 sm:py-3">
                <DocumentRenderer text={displayText} compact />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function Home() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <HomeInner />
    </Suspense>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="font-serif italic text-xl text-muted-foreground">Loading…</div>
    </div>
  );
}

function HomeInner() {
  const { user, loading, signOut, getIdToken } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [tab, setTab]             = useState<Tab>('input');
  const [inputMode, setInputMode] = useState<InputMode>('paste');
  const [inputText, setInputText] = useState('');
  const [uploadedFilename, setUploadedFilename] = useState('');
  const [stages, setStages]       = useState<StageState[]>(INITIAL_STAGES);
  const [chunks, setChunks]       = useState<ChunkData[]>([]);
  const [expandedChunks, setExpandedChunks] = useState<Set<number>>(new Set());
  const [output, setOutput]       = useState('');
  const [outputMeta, setOutputMeta] = useState({ words: 0, chunkCount: 0, flagsCount: 0 });
  const [isRunning, setIsRunning] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [copied, setCopied]       = useState(false);
  const [enforcerCorrections, setEnforcerCorrections] = useState<EnforcerCorrection[]>([]);
  const [enforcerTotalFixes, setEnforcerTotalFixes] = useState(0);
  const [mainMenuOpen, setMainMenuOpen] = useState(false);
  // No reviewer state — the pipeline produces flags + corrections only.
  const [rulesExpanded, setRulesExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [translationId, setTranslationId] = useState<string | null>(null);
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const [reviewSectionIndex, setReviewSectionIndex] = useState(0);
  const [commentCounts, setCommentCounts] = useState<Record<number, number>>({});
  const [processingMode, setProcessingMode] = useState<'cloud' | 'local' | null>(null);
  const [pipelineCommentary, setPipelineCommentary] = useState<string | null>(null);

  // Book mode
  const [isBookMode, setIsBookMode]     = useState(false);
  const [bookChapters, setBookChapters] = useState<ChapterResult[]>([]);
  const [bookOutputs, setBookOutputs]   = useState<string[]>([]);
  const [currentChapterIdx, setCurrentChapterIdx] = useState(0);
  const detectedChaptersRef = useRef<Array<{ title: string; startLine: number }> | null>(null);

  const abortRef  = useRef<AbortController | null>(null);
  const chunkMap  = useRef<Record<number, ChunkData>>({});

  // Auth redirect
  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  // Load translation from history when ?view=<translationId> is present
  useEffect(() => {
    const viewId = searchParams.get('view');
    if (!viewId || !user) return;
    (async () => {
      const token = await getIdToken();
      if (!token) return;
      try {
        const res = await fetch('/api/history', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const data = await res.json();
        const translations = data.translations as Array<{ id: string; output: string; outputWordCount: number; chapterTitle: string | null; bookTitle: string | null; bookId: string | null }>;
        if (!translations) return;

        const bookId = searchParams.get('book');
        if (bookId) {
          // Load full book
          const bookChaps = translations.filter(t => t.bookId === bookId).sort((a, b) => ((a as Record<string, unknown>).chapterIndex as number ?? 0) - ((b as Record<string, unknown>).chapterIndex as number ?? 0));
          if (bookChaps.length > 0) {
            const combined = bookChaps.map(c => c.output).join('\n\n');
            setOutput(combined);
            setOutputMeta({ words: wc(combined), chunkCount: bookChaps.length, flagsCount: 0 });
            setTranslationId(bookChaps[0].id);
            setUploadedFilename(bookChaps[0].bookTitle ?? '');
            setTab('output');
          }
        } else {
          // Load single translation
          const t = translations.find(t => t.id === viewId);
          if (t) {
            setOutput(t.output);
            setOutputMeta({ words: t.outputWordCount, chunkCount: 1, flagsCount: 0 });
            setTranslationId(t.id);
            setUploadedFilename(t.chapterTitle ?? t.bookTitle ?? '');
            setTab('output');
          }
        }
        // Clear the query param without reload
        window.history.replaceState({}, '', '/');
      } catch { /* ignore */ }
    })();
  }, [searchParams, user, getIdToken]);

  const updateStage = useCallback((id: string, updates: Partial<StageState>) => {
    setStages(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);

  const toggleChunk = useCallback((i: number) => {
    setExpandedChunks(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  }, []);

  const words = wc(inputText);

  // ── Run a single section through the pipeline ──────────────────────────────

  // ── Apply polling progress to UI state ────────────────────────────────────

  const applyProgress = useCallback((progress: Record<string, unknown> | null) => {
    if (!progress) return;
    const stages = progress.stages as Record<string, Record<string, unknown>> | undefined;
    const pollChunks = progress.chunks as Array<Record<string, unknown>> | undefined;
    const commentary = progress.commentary as string | undefined;
    if (commentary) setPipelineCommentary(commentary);

    if (stages) {
      setStages(prev => prev.map(s => {
        const sd = stages[s.id];
        if (!sd) return s;
        const status = (sd.status as StageStatus) ?? s.status;
        let msg = s.tagline;
        let progressPct: number | null = null;

        if (s.id === 'chunker' && status === 'done') {
          const n = sd.chunkCount as number ?? 0;
          msg = `Split into ${n} chunk${n !== 1 ? 's' : ''} at paragraph/verse boundaries`;
          progressPct = 100;
        }
        if (s.id === 'translator') {
          const c = sd.completed as number ?? 0, t = sd.total as number ?? 1;
          if (status === 'running') {
            if (t === 1) { msg = 'Translating…'; progressPct = null; }
            else { msg = `Translated ${c} of ${t} chunks…`; progressPct = Math.round(c / t * 100); }
          }
          if (status === 'done') { msg = t === 1 ? 'Translation complete' : `All ${t} chunks translated`; progressPct = 100; }
        }
        if (s.id === 'smoother') {
          const c = sd.completed as number ?? 0, t = sd.total as number ?? 1;
          if (status === 'running') {
            if (t === 1) { msg = 'Applying readability pass…'; progressPct = null; }
            else { msg = `Smoothed ${c} of ${t} chunks…`; progressPct = Math.round(c / t * 100); }
          }
          if (status === 'done') { msg = 'Readability pass complete'; progressPct = 100; }
        }
        if (s.id === 'assembler') {
          if (status === 'running') msg = 'Joining chunks into a single document…';
          if (status === 'done') msg = 'Document assembled';
        }
        if (s.id === 'enforcer') {
          if (status === 'running') msg = 'Applying Aksharpith house rules…';
          if (status === 'done') { const f = sd.totalFixes as number ?? 0; msg = `Rules enforced — ${f} correction${f !== 1 ? 's' : ''} applied`; }
        }

        return { ...s, status, msg, progress: progressPct };
      }));
    }

    // Update chunk cards from poll data. The user-facing API only returns
    // index, original, translation, and flags. The pipeline no longer
    // produces score/categories/deductions fields after the pare-down at the
    // /api/translate/[jobId] boundary and only surface in /admin.
    if (pollChunks && pollChunks.length > 0) {
      for (const c of pollChunks) {
        const idx = c.index as number;
        const existing = chunkMap.current[idx] ?? { index: idx, original: '' };
        chunkMap.current[idx] = {
          ...existing,
          translation: (c.translation as string) ?? existing.translation,
          flags: Array.isArray(c.flags) ? (c.flags as string[]) : existing.flags,
        };
      }
      setChunks(Object.values(chunkMap.current).sort((a, b) => a.index - b.index));
    }
  }, []);

  // ── Run a single section through the pipeline (polling) ────────────────────

  const runSection = async (text: string, chapterTitle?: string, bookId?: string, chapterIndex?: number, totalChapters?: number): Promise<{ output: string; flagsCount: number; wordCount: number } | null> => {
    // In book mode, don't reset stages between chapters — show continuous progress
    // The chapter bar handles per-chapter tracking
    if (!bookId) {
      setStages(INITIAL_STAGES);
    } else {
      // Update all stages to show current chapter context
      const chLabel = `Section ${(chapterIndex ?? 0) + 1}/${totalChapters ?? '?'}`;
      setStages(prev => prev.map(s => s.status === 'done' ? { ...s, status: 'waiting' as const, msg: '', progress: null } : s));
      updateStage('chunker', { status: 'running', msg: `${chLabel} — preparing…` });
    }
    setChunks([]);
    setExpandedChunks(new Set());
    chunkMap.current = {};

    const token = await getIdToken();

    // Step 1: Create job
    const createRes = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text, chapterTitle, bookId, chapterIndex, totalChapters, bookTitle: uploadedFilename || undefined }),
      signal: abortRef.current?.signal,
    });

    if (!createRes.ok) {
      const err = await createRes.text().catch(() => `HTTP ${createRes.status}`);
      throw new Error(err);
    }

    const { jobId, mode } = await createRes.json();
    // Only escalate — once local, stays local (for book mode with mixed chapters)
    setProcessingMode(prev => mode === 'local' ? 'local' : (prev ?? mode ?? 'cloud'));

    if (mode === 'local') {
      // Estimate: ~30s per 500-word chunk (translate + review + smooth)
      const estChunks = Math.ceil((text.trim().split(/\s+/).length) / 500);
      const estMinutes = Math.max(1, Math.round(estChunks * 30 / 60));
      updateStage('chunker', { status: 'running', msg: `Processing locally — estimated ${estMinutes} min for this document…` });
    } else {
      updateStage('chunker', { status: 'running', msg: 'Job created — pipeline starting…' });
      // Trigger pipeline on Vercel (fire-and-forget — blocks on server while pipeline runs)
      fetch(`/api/translate/${jobId}/run`, {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      }).catch(() => { /* polling will detect failures */ });
    }

    // Step 3: Poll for status
    let result: { output: string; flagsCount: number; wordCount: number } | null = null;
    const pollStart = Date.now();

    while (true) {
      if (abortRef.current?.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      await new Promise(r => setTimeout(r, 800));

      const freshToken = await getIdToken();
      const pollRes = await fetch(`/api/translate/${jobId}`, {
        headers: freshToken ? { 'Authorization': `Bearer ${freshToken}` } : {},
        signal: abortRef.current?.signal,
      });

      if (!pollRes.ok) throw new Error(`Poll failed: HTTP ${pollRes.status}`);
      const poll = await pollRes.json();

      // Warn if local job hasn't started after 15s
      if (mode === 'local' && poll.status === 'pending' && Date.now() - pollStart > 15000) {
        updateStage('chunker', { status: 'running', msg: 'Queued for local processing — the worker will pick this up shortly…' });
      }

      // Apply progress to UI
      applyProgress(poll.progress);

      if (poll.status === 'completed' && poll.result) {
        const r = poll.result;
        setEnforcerCorrections(r.corrections ?? []);
        setEnforcerTotalFixes(r.totalFixes ?? 0);
        if (r.translationId) setTranslationId(r.translationId);
        result = { output: r.output, flagsCount: r.flagsCount ?? 0, wordCount: r.wordCount };
        break;
      }

      if (poll.status === 'failed') {
        throw new Error(poll.error || 'Pipeline failed');
      }
    }

    return result;
  };

  // ── Server-side book enqueue ───────────────────────────────────────────────
  // POST all chapters at once; subscribe to each via Firestore onSnapshot.
  // No client-side for-loop: closing the browser tab no longer stops the book.
  const runBookViaServerEnqueue = async (
    chapterArr: Array<{ chapterIndex: number; chapterTitle: string; text: string }>,
    bookId: string,
    bookTitle?: string,
  ): Promise<string[]> => {
    const token = await getIdToken();
    const res = await fetch('/api/translate-book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
      body: JSON.stringify({ bookId, bookTitle, chapters: chapterArr }),
      signal: abortRef.current?.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(err);
    }
    const { chapterJobs } = (await res.json()) as {
      chapterJobs: Array<{ chapterIndex: number; jobId: string }>;
    };

    setProcessingMode('local');
    updateStage('chunker', { status: 'running', msg: `${chapterJobs.length} chapter jobs queued — worker is picking them up…` });

    const db = getFirebaseDb();
    const outputs: string[] = new Array(chapterArr.length).fill('');
    type SnapState = {
      status: 'pending' | 'running' | 'completed' | 'failed';
      result: { output?: string; flagsCount?: number; wordCount?: number } | null;
      progress: Record<string, unknown> | null;
    };
    const states = new Map<number, SnapState>();

    return new Promise<string[]>((resolve, reject) => {
      const unsubs: Array<() => void> = [];
      let aborted = false;

      const onAbort = () => {
        aborted = true;
        unsubs.forEach((u) => u());
        reject(new DOMException('Aborted', 'AbortError'));
      };
      abortRef.current?.signal.addEventListener('abort', onAbort);

      for (const { chapterIndex, jobId } of chapterJobs) {
        const ref = doc(db, 'jobs', jobId);
        const unsub = onSnapshot(
          ref,
          (snap) => {
            if (aborted) return;
            const data = snap.data() as Record<string, unknown> | undefined;
            if (!data) return;

            const status = data.status as SnapState['status'];
            const r = (data.result ?? null) as SnapState['result'];
            const progress = (data.progress ?? null) as SnapState['progress'];
            const inputObj = (data.input ?? {}) as { wordCount?: number };

            states.set(chapterIndex, { status, result: r, progress });

            const uiStatus =
              status === 'completed' ? ('done' as const) :
              status === 'failed' ? ('error' as const) :
              status as 'pending' | 'running';

            setBookChapters((prev) =>
              prev.map((c, i) =>
                i === chapterIndex
                  ? {
                      ...c,
                      status: uiStatus,
                      output: r?.output ?? c.output,
                      flagsCount: r?.flagsCount ?? c.flagsCount,
                      wordCount: r?.wordCount ?? inputObj.wordCount ?? c.wordCount,
                    }
                  : c,
              ),
            );

            if (status === 'completed' && r?.output) {
              outputs[chapterIndex] = r.output;
              setBookOutputs([...outputs]);
            }

            // Mirror the live pipeline UI to whichever chapter is running first in queue order
            const runningSorted = Array.from(states.entries())
              .filter(([, s]) => s.status === 'running')
              .sort(([a], [b]) => a - b);
            if (runningSorted.length > 0) {
              const [idx, s] = runningSorted[0];
              setCurrentChapterIdx(idx);
              if (s.progress) applyProgress(s.progress as Parameters<typeof applyProgress>[0]);
            }

            if (states.size === chapterJobs.length) {
              const allFinished = Array.from(states.values()).every(
                (s) => s.status === 'completed' || s.status === 'failed',
              );
              if (allFinished) {
                unsubs.forEach((u) => u());
                abortRef.current?.signal.removeEventListener('abort', onAbort);
                const failed = Array.from(states.entries()).filter(([, s]) => s.status === 'failed');
                if (failed.length > 0) {
                  const labels = failed.map(([i]) => `chapter ${i + 1}`).join(', ');
                  setPipelineError(`Some chapters failed: ${labels}. See /admin for details.`);
                }
                resolve(outputs);
              }
            }
          },
          (err) => {
            unsubs.forEach((u) => u());
            abortRef.current?.signal.removeEventListener('abort', onAbort);
            reject(new Error(`Firestore snapshot error: ${err.message}`));
          },
        );
        unsubs.push(unsub);
      }
    });
  };

  // ── Handle run ─────────────────────────────────────────────────────────────

  const handleRun = async () => {
    if (!inputText.trim() || isRunning) return;
    if (words > MAX_WORDS) {
      setPipelineError(`Input too long (${words.toLocaleString()} words). Maximum is ${MAX_WORDS.toLocaleString()} words.`);
      return;
    }
    if (words > WARN_WORDS && !isBookMode) {
      setPipelineError(`Warning: ${words.toLocaleString()} words may timeout on a single run. Upload your document to enable book mode, which processes chapter by chapter.`);
      return;
    }

    setPipelineError(null);
    setOutput('');
    setEnforcerCorrections([]);
    setRulesExpanded(false);
    setOutputExpanded(false);
    setTranslationId(null);
    setCommentCounts({});
    setEnforcerTotalFixes(0);
    setProcessingMode(null);
    setPipelineCommentary(null);
    setIsRunning(true);
    setTab('pipeline');
    abortRef.current = new AbortController();

    try {
      if (isBookMode && bookChapters.length > 0) {
        setBookChapters(prev => prev.map(c => ({ ...c, status: 'pending' as const, output: undefined, flagsCount: undefined, wordCount: undefined })));
        const bookRunId = crypto.randomUUID();
        const chapterLines = inputText.split('\n');

        // Build chapter array for the server endpoint.
        const chapterArr = bookChapters.map((bc, i) => {
          const start = bc.startLine ?? 0;
          const end   = bookChapters[i + 1]?.startLine ?? chapterLines.length;
          return { chapterIndex: i, chapterTitle: bc.title, text: chapterLines.slice(start, end).join('\n').trim() };
        }).filter(c => c.text);

        if (chapterArr.length === 0) {
          setPipelineError('No non-empty chapters detected in the upload');
        } else {
          try {
            const outputs = await runBookViaServerEnqueue(chapterArr, bookRunId, uploadedFilename || undefined);
            const combined = outputs.filter(Boolean).join('\n\n');
            setOutput(combined);
            const totalFlags = bookChapters.reduce((s, c) => s + (c.flagsCount ?? 0), 0);
            setOutputMeta({
              words: wc(combined),
              chunkCount: chapterArr.length,
              flagsCount: totalFlags,
            });
            if (combined) setTimeout(() => setTab('output'), 400);
          } catch (e) {
            if ((e as Error).name !== 'AbortError') {
              setPipelineError(`Book translation failed: ${(e as Error).message}`);
            }
          }
        }

      } else {
        const res = await runSection(inputText);
        if (res) {
          setOutput(res.output);
          setOutputMeta({ words: res.wordCount, chunkCount: Object.keys(chunkMap.current).length, flagsCount: res.flagsCount });
          setTimeout(() => setTab('output'), 400);
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') {
        const msg = e.message;
        setPipelineError(msg);
        setStages(prev => prev.map(s => s.status === 'running' ? { ...s, status: 'error', msg } : s));
      }
    } finally {
      setIsRunning(false);
    }
  };

  const handleStop = () => { abortRef.current?.abort(); };

  const handleFileExtracted = (text: string, filename: string, chapters: Array<{ title: string; startLine: number }> | null) => {
    setInputText(text);
    setUploadedFilename(filename);
    detectedChaptersRef.current = chapters;
    if (chapters && chapters.length > 1) {
      setIsBookMode(true);
      setBookChapters(chapters.map((ch, i) => ({ title: ch.title, index: i, status: 'pending', startLine: ch.startLine })));
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const update = () => {
      if (headerRef.current) document.documentElement.style.setProperty('--header-h', headerRef.current.offsetHeight + 'px');
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="font-serif italic text-xl text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const errorBanner = pipelineError && (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 sm:px-4 text-sm text-destructive">
      <strong className="font-semibold">Error: </strong>{pipelineError}
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-background">

      {/* Header — shadcn / Tailwind v4. Logo + serif title, ghost menu button. */}
      <header ref={headerRef} className="sticky top-0 z-50 bg-paper/95 backdrop-blur border-b border-border">
        <div className="mx-auto max-w-3xl px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/baps-logo.png" alt="" className="h-9 w-auto opacity-85" />
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
                Aksharpith
              </div>
              <div className="font-serif text-xl text-foreground leading-tight">
                Transliteration <em className="italic font-normal">Pipeline</em>
              </div>
            </div>
          </div>
          {user && (
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMainMenuOpen(!mainMenuOpen)}
                aria-label="Open menu"
                aria-expanded={mainMenuOpen}
                className="min-h-[44px] min-w-[44px]"
              >
                <span aria-hidden className="text-base">☰</span>
              </Button>
              {mainMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMainMenuOpen(false)} aria-hidden />
                  <div className="absolute right-0 top-12 z-20 min-w-[220px] rounded-md border bg-popover shadow-md overflow-hidden">
                    <div className="px-3 py-2.5 border-b text-xs text-muted-foreground truncate font-mono">
                      {user.email}
                    </div>
                    <button
                      type="button"
                      onClick={() => { setMainMenuOpen(false); router.push('/history'); }}
                      className="block w-full text-left px-3 py-3 min-h-[44px] text-sm hover:bg-accent transition-colors"
                    >
                      History
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMainMenuOpen(false); signOut(); }}
                      className="block w-full text-left px-3 py-3 min-h-[44px] text-sm hover:bg-accent border-t transition-colors"
                    >
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Active in-flight transliteration jobs (Phase 3). Self-hides when
          there are none. Read-only — does not touch the upload pipeline. */}
      <ActiveJobsStrip />

      {/* Tab strip — sticky under header */}
      <div className="sticky z-40 bg-paper/95 backdrop-blur border-b border-border" style={{ top: 'var(--header-h, 60px)' }}>
        <div className="mx-auto max-w-3xl px-4 sm:px-5 flex">
          {(['input', 'pipeline', 'output'] as Tab[]).map(t => {
            const active = tab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                aria-pressed={active}
                className={cn(
                  'flex-1 min-h-[44px] py-3 text-[10px] sm:text-[11px] font-mono uppercase tracking-[0.15em] transition-colors',
                  'border-b-2',
                  active
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground/70',
                )}
              >
                {t}{t === 'output' && output ? ' ·' : ''}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── INPUT TAB ── */}
      {tab === 'input' && (
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-5 py-5 sm:py-6 flex flex-col gap-4 sm:gap-5">

          {errorBanner}

          {/* Input mode toggle — segmented, ≥44px tall on touch devices */}
          <div className="flex rounded-md border bg-paper-warm p-1" role="tablist" aria-label="Input mode">
            {(['paste', 'upload'] as InputMode[]).map(m => (
              <button
                key={m}
                role="tab"
                aria-selected={inputMode === m}
                onClick={() => setInputMode(m)}
                className={cn(
                  'flex-1 min-h-[44px] rounded-[6px] font-mono text-[11px] uppercase tracking-wider transition-colors',
                  inputMode === m
                    ? 'bg-paper text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m === 'paste' ? 'Paste Text' : 'Upload File'}
              </button>
            ))}
          </div>

          {/* Source input */}
          <div className="rounded-md border bg-paper px-4 py-5 sm:px-6 sm:py-6">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
              {inputMode === 'paste' ? 'Gujarati Source Text' : 'Upload Document'}
            </div>

            {inputMode === 'upload' ? (
              <>
                <FileUpload onExtracted={handleFileExtracted} disabled={isRunning} getToken={getIdToken} />
                {inputText && (
                  <div className="mt-3 rounded-md border bg-paper-warm/70 px-3 py-2.5 sm:px-4">
                    <div className="text-[11px] font-mono uppercase tracking-wider text-[oklch(0.42_0.10_145)] mb-1">
                      ✓ Extracted — {uploadedFilename}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {words.toLocaleString()} words
                      {isBookMode && bookChapters.length > 0 && ` · ${bookChapters.length} sections detected — book mode active`}
                    </div>
                    <div className="mt-1.5 font-serif italic text-[13px] leading-relaxed text-muted-foreground/80 line-clamp-3">
                      {inputText.slice(0, 200)}…
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <textarea
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  placeholder="Paste Gujarati text here…"
                  disabled={isRunning}
                  className="w-full mt-2 min-h-[200px] rounded-md border bg-background px-3 py-3 sm:px-4 text-[16px] sm:text-[17px] leading-[1.8] text-foreground outline-none resize-y focus:border-foreground/40 transition-colors"
                />
                <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="button"
                    onClick={() => setInputText(SAMPLE)}
                    className="self-start min-h-[44px] sm:min-h-0 px-2 -ml-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Load sample text
                  </button>
                  <div className={cn(
                    'text-xs tabular-nums',
                    words > MAX_WORDS ? 'text-destructive' : 'text-muted-foreground',
                  )}>
                    {words.toLocaleString()} / {MAX_WORDS.toLocaleString()} words
                    {words > MAX_WORDS ? ' — too long' : words > WARN_WORDS ? ' — use book mode' : ''}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Book mode panel */}
          {isBookMode && bookChapters.length > 0 && (
            <div className="rounded-md border border-[oklch(0.85_0.04_145)] bg-[oklch(0.97_0.025_145)] px-4 py-4 sm:px-5 sm:py-5">
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <div className="font-serif text-base text-foreground">Book Mode</div>
                <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider">
                  {bookChapters.length} sections
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Each section is processed through the full pipeline. Translation memory is preserved across sections.
              </p>
              <ul className="mt-3 space-y-1">
                {bookChapters.slice(0, 8).map((ch, i) => (
                  <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                    <span className="font-mono text-muted-foreground/70 w-5 shrink-0 tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                    <span className="truncate">{ch.title}</span>
                  </li>
                ))}
                {bookChapters.length > 8 && (
                  <li className="text-xs text-muted-foreground/70">+{bookChapters.length - 8} more…</li>
                )}
              </ul>
              <button
                type="button"
                onClick={() => { setIsBookMode(false); setBookChapters([]); }}
                className="mt-3 min-h-[44px] sm:min-h-0 px-2 -ml-2 text-xs text-[oklch(0.42_0.10_145)] hover:underline"
              >
                Switch to single-section mode
              </button>
            </div>
          )}

          {/* Aksharpith reference context */}
          <div className="rounded-r-md border-l-2 border-l-muted-foreground/30 bg-paper-warm/60 px-4 py-4 sm:px-5">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2.5">
              Reference Context Loaded
            </div>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {[
                'Aksharpith House Rules (full)',
                'Aksharpith Master Glossary',
                'Sadhu-approved 4-prompt chain',
                'BAPS terminology corrections',
                'Documented corrections archive',
                'Translator self-flag protocol',
              ].map(rule => (
                <li key={rule} className="flex gap-2 text-xs text-muted-foreground items-start">
                  <span className="text-[oklch(0.42_0.10_145)] font-medium shrink-0" aria-hidden>✓</span>
                  {rule}
                </li>
              ))}
            </ul>
          </div>

          {/* Run / stop — single CTA. Min-height ensures touch target. */}
          <Button
            onClick={isRunning ? handleStop : handleRun}
            disabled={!isRunning && !inputText.trim()}
            variant={isRunning ? 'outline' : 'default'}
            size="lg"
            className="w-full min-h-[52px] font-serif text-base sm:text-lg"
          >
            {isRunning
              ? `${isBookMode ? `Processing chapter ${currentChapterIdx + 1} of ${bookChapters.length}` : 'Translation in progress'} — tap to stop`
              : `Begin ${isBookMode ? 'book ' : ''}translation`}
          </Button>
        </div>
      )}

      {/* ── PIPELINE TAB ── */}
      {tab === 'pipeline' && (
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-5 py-5 sm:py-6 flex flex-col gap-3">

          {errorBanner}

          {/* Processing mode badge */}
          {processingMode && (
            <Badge
              variant="outline"
              className={cn(
                'self-start font-mono text-[10px] uppercase tracking-wider px-2.5 py-1',
                processingMode === 'local'
                  ? 'border-[oklch(0.78_0.10_270)] text-[oklch(0.45_0.13_270)] bg-[oklch(0.97_0.02_270)]'
                  : 'border-[oklch(0.80_0.09_165)] text-[oklch(0.42_0.10_165)] bg-[oklch(0.97_0.02_165)]',
              )}
            >
              {processingMode === 'local' ? 'Local processing' : 'Cloud processing'}
            </Badge>
          )}

          {isBookMode && <ChapterBar chapters={bookChapters} />}

          {/* Stage cards — vertical list, no spinners, words tell the story */}
          <div className="flex flex-col gap-2">
            {stages.map(stage => (
              <StageCard
                key={stage.id}
                stage={stage}
                commentary={stage.status === 'running' ? pipelineCommentary : null}
              />
            ))}
          </div>

          {/* Chunk detail */}
          {chunks.length > 0 && (
            <div className="mt-6 sm:mt-9">
              <div className="flex items-baseline gap-3 mb-1 flex-wrap">
                <h2 className="font-serif text-xl sm:text-2xl text-foreground">Chunk Detail</h2>
                <span className="text-xs text-muted-foreground/80">Tap any chunk to expand</span>
              </div>
              <div className="w-12 h-px bg-border my-2 mb-4" />

              {/* Flag legend — translator self-flags only, not quality scores */}
              <div className="mb-4 rounded-md border bg-paper-warm/60 px-3 py-2.5 sm:px-4">
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                  Translator self-flags
                </div>
                <ul className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-x-5 sm:gap-y-1.5 text-xs text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[oklch(0.65_0.13_145)] shrink-0" aria-hidden />
                    0 flags — translator was confident
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[oklch(0.75_0.14_75)] shrink-0" aria-hidden />
                    1–2 flags — verify against source
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[oklch(0.62_0.18_45)] shrink-0" aria-hidden />
                    3+ flags — read flagged spans
                  </li>
                </ul>
              </div>

              {chunks.map(chunk => (
                <ChunkCard
                  key={chunk.index}
                  chunk={chunk}
                  expanded={expandedChunks.has(chunk.index)}
                  onToggle={() => toggleChunk(chunk.index)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Review Panel Overlay ── */}
      <ReviewPanel
        translationId={translationId}
        sectionIndex={reviewSectionIndex}
        open={reviewPanelOpen}
        onClose={() => {
          setReviewPanelOpen(false);
          // Refresh comment counts for the section
          if (translationId) {
            (async () => {
              try {
                const token = await getIdToken();
                const res = await fetch(`/api/reviews/${translationId}`, {
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                if (res.ok) {
                  const data = await res.json();
                  const counts: Record<number, number> = {};
                  for (const c of (data.comments ?? [])) {
                    const idx = (c as Record<string, unknown>).sectionIndex as number;
                    counts[idx] = (counts[idx] ?? 0) + 1;
                  }
                  setCommentCounts(counts);
                }
              } catch { /* ignore */ }
            })();
          }
        }}
        user={user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null}
        getToken={getIdToken}
      />

      {/* ── OUTPUT TAB ── */}
      {tab === 'output' && (
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-5 py-5 sm:py-6 flex flex-col gap-4">
          {!output ? (
            <div className="text-center py-12">
              <div className="font-serif italic text-2xl text-muted-foreground mb-2">
                {isRunning ? 'Processing…' : 'No output yet'}
              </div>
              <p className="text-sm text-muted-foreground/70">
                {isRunning ? 'Live progress is on the Pipeline tab.' : 'Start the pipeline to see output here.'}
              </p>
            </div>
          ) : (
            <>
              {/* Document page — paper-like card, mobile padding scales down */}
              <div className="rounded-md bg-paper border shadow-sm px-5 py-8 sm:px-12 sm:py-12 min-h-[300px]">
                {/* Document title */}
                <div className="text-center mb-6 sm:mb-8">
                  <div className="font-serif text-2xl sm:text-[28px] font-semibold text-foreground leading-tight">
                    {uploadedFilename
                      ? uploadedFilename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
                      : 'Translation'}
                  </div>
                  <div className="font-serif italic text-sm text-muted-foreground mt-1">
                    {isBookMode && bookChapters.length > 0
                      ? `${bookChapters.length} sections — Gujarati to English`
                      : 'Gujarati to English Translation'}
                  </div>
                  <div className="w-14 h-px bg-border mx-auto mt-5" />
                </div>

                {/* Document body — collapsible with fade overlay */}
                <div className={cn(
                  'relative overflow-hidden transition-[max-height] duration-300',
                  outputExpanded ? 'max-h-none' : 'max-h-80',
                )}>
                  <OutputView
                    output={output}
                    onCommentClick={(sectionIndex) => {
                      setReviewSectionIndex(sectionIndex);
                      setReviewPanelOpen(true);
                    }}
                    commentCounts={commentCounts}
                  />
                  {!outputExpanded && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-paper" />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setOutputExpanded(prev => !prev)}
                  className="block w-full mt-3 min-h-[44px] font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                >
                  {outputExpanded ? '▲ Collapse translation' : '▼ Expand full translation'}
                </button>

                {/* Footer */}
                <div className="mt-8 pt-4 border-t border-border/60 text-center">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
                    Aksharpith Translation Pipeline
                  </span>
                </div>
              </div>

              {/* Quality summary below document — corrections only. No
                  metrics are admin-only and live at /admin */}
              <QualitySummary
                corrections={enforcerCorrections}
                totalFixes={enforcerTotalFixes}
              />

              {/* Actions — wraps to two rows on mobile */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center flex-wrap gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                  <span>{outputMeta.words.toLocaleString()} words</span>
                  <span className="text-border">·</span>
                  <span>
                    {outputMeta.chunkCount} section{outputMeta.chunkCount !== 1 ? 's' : ''}
                  </span>
                  {outputMeta.flagsCount > 0 && (
                    <>
                      <span className="text-border">·</span>
                      <span className="font-mono">
                        {outputMeta.flagsCount} self-flag{outputMeta.flagsCount === 1 ? '' : 's'}
                      </span>
                    </>
                  )}
                </div>
                <div className="flex gap-2 self-start sm:self-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopy}
                    className="min-h-[44px] sm:min-h-0 font-mono text-[11px] uppercase tracking-wider"
                  >
                    {copied ? '✓ Copied' : 'Copy'}
                  </Button>
                  <DownloadMenu
                    output={output}
                    translationId={translationId}
                    filename={uploadedFilename}
                    getToken={getIdToken}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
