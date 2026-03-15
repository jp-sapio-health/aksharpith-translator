'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useAuth } from '../lib/auth-context';
import { useRouter } from 'next/navigation';

// ── Types ──────────────────────────────────────────────────────────────────────

type StageStatus = 'waiting' | 'running' | 'done' | 'error';
type Tab = 'input' | 'pipeline' | 'output';
type InputMode = 'paste' | 'upload';

interface StageState {
  id: 'chunker' | 'translator' | 'reviewer' | 'smoother' | 'assembler';
  num: string; label: string; tagline: string;
  status: StageStatus; msg: string; progress: number | null;
}

interface Reviewer1Category { id: string; name: string; pass: boolean; issues: string[]; }

interface ChunkData {
  index: number; original: string;
  translation?: string;
  reviewer1?: { categories: Reviewer1Category[]; pitfalls: string[]; score: number; certifiable: boolean };
  score?: number; issues?: string[]; revised?: string; approved?: boolean;
}

interface ChapterResult {
  title: string; index: number; startLine: number;
  status: 'pending' | 'running' | 'done' | 'error';
  output?: string; avgScore?: number; wordCount?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const INITIAL_STAGES: StageState[] = [
  { id: 'chunker',    num: '01', label: 'Chunker',    tagline: 'Splits text at paragraph and verse boundaries into \u2264500-word segments', status: 'waiting', msg: '', progress: null },
  { id: 'translator', num: '02', label: 'Translator', tagline: 'Translates each chunk \u2014 trustee-of-tradition mindset, full BAPS glossary enforced', status: 'waiting', msg: '', progress: null },
  { id: 'reviewer',   num: '03', label: 'Reviewer',   tagline: 'BAPS certification (8 categories, 20 pitfalls) + style and register audit in one pass', status: 'waiting', msg: '', progress: null },
  { id: 'smoother',   num: '04', label: 'Smoother',   tagline: 'Readability pass \u2014 natural flow and transitions, without altering meaning', status: 'waiting', msg: '', progress: null },
  { id: 'assembler',  num: '05', label: 'Assembler',  tagline: 'Joins all chunks into a single publication-ready document', status: 'waiting', msg: '', progress: null },
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

function scoreTier(score: number): { label: string; type: 'strong' | 'adequate' | 'weak'; desc: string } {
  if (score >= 90) return { label: 'Publication Ready', type: 'strong',   desc: 'Meets all Aksharpith publication standards.' };
  if (score >= 80) return { label: 'Strong',            type: 'strong',   desc: 'Minor issues corrected — ready for editorial sign-off.' };
  if (score >= 70) return { label: 'Revised',           type: 'adequate', desc: 'Multiple corrections applied by both reviewers.' };
  if (score >= 60) return { label: 'Needs Work',        type: 'adequate', desc: 'Significant revision was required — verify manually.' };
  return              { label: 'Poor',             type: 'weak',     desc: 'Major issues found — consider retranslating this chunk.' };
}

function wc(t: string) { return t.trim() ? t.trim().split(/\s+/).length : 0; }

// ── StageCard ──────────────────────────────────────────────────────────────────

function StageCard({ stage }: { stage: StageState }) {
  const s = stage.status;
  return (
    <div style={{
      background: s === 'running' ? 'var(--amber-bg)' : s === 'done' ? 'var(--green-bg)' : s === 'error' ? 'var(--red-bg)' : 'var(--bg-white)',
      border: `1px solid ${s === 'running' ? 'var(--amber-border)' : s === 'done' ? 'var(--green-border)' : s === 'error' ? 'var(--red-border)' : 'var(--border)'}`,
      borderRadius: 'var(--radius)', padding: '18px 22px', transition: 'all 0.3s',
    }} className="fadein">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 13, letterSpacing: 1, color: 'var(--text-light)', width: 20 }}>{stage.num}</span>
          <span style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 22, fontWeight: 400, color: (s === 'running' || s === 'done') ? 'var(--text)' : 'var(--text-muted)', transition: 'color 0.3s' }}>{stage.label}</span>
        </div>
        {s === 'done'    && <span style={badgeStyle('strong')}>Done</span>}
        {s === 'running' && <span style={badgeStyle('running')}>Running <span className="spinning" style={{ marginLeft: 4 }}>◌</span></span>}
        {s === 'error'   && <span style={badgeStyle('weak')}>Error</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--text-muted)', marginTop: 4, paddingLeft: 32, lineHeight: 1.6 }}>
        {stage.msg || stage.tagline}
      </div>
      {s === 'running' && stage.progress !== null && (
        <div style={{ paddingLeft: 32, marginTop: 10 }}>
          <div style={{ height: 1, background: 'var(--border)', borderRadius: 2 }}>
            <div style={{ height: '100%', background: 'var(--amber)', borderRadius: 2, width: `${stage.progress}%`, transition: 'width 0.4s' }} />
          </div>
        </div>
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

function FileUpload({ onExtracted, disabled, getToken }: { onExtracted: (text: string, filename: string, chapters: Array<{ title: string; startLine: number }> | null) => void; disabled: boolean; getToken: () => Promise<string | null> }) {
  const [dragging, setDragging]           = useState(false);
  const [selectedFile, setSelectedFile]   = useState<File | null>(null);
  const [phase, setPhase]                 = useState<UploadPhase>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError]                 = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef   = useRef<XMLHttpRequest | null>(null);

  const startUpload = async (file: File) => {
    setSelectedFile(file);
    setError(null);
    setPhase('uploading');
    setUploadProgress(0);

    const token = await getToken();
    const fd = new FormData();
    fd.append('file', file);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) setUploadProgress(Math.round(e.loaded / e.total * 100));
    });

    xhr.upload.addEventListener('loadend', () => {
      setPhase('processing');
    });

    xhr.addEventListener('load', () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 400 || data.error) {
          setError(data.error ?? `Upload failed (HTTP ${xhr.status})`);
          setPhase('error');
        } else {
          setPhase('done');
          onExtracted(data.text ?? '', data.filename ?? file.name, data.chapters ?? null);
        }
      } catch {
        setError('Failed to parse server response');
        setPhase('error');
      }
    });

    xhr.addEventListener('error', () => {
      setError('Upload failed — check your connection and try again');
      setPhase('error');
    });

    xhr.addEventListener('timeout', () => {
      setError('Upload timed out — file may be too large for your connection');
      setPhase('error');
    });

    xhr.timeout = 300000; // 5 min
    xhr.open('POST', '/api/upload');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(fd);
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="spinning" style={{ color: 'var(--amber)' }}>◌</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>Processing with Claude…</div>
                  <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--text-light)', marginTop: 2 }}>Extracting text, preserving Gujarati Unicode and structure</div>
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

// ── ChunkCard ──────────────────────────────────────────────────────────────────

function ChunkCard({ chunk, expanded, onToggle }: { chunk: ChunkData; expanded: boolean; onToggle: () => void }) {
  const hasR1 = chunk.reviewer1 !== undefined;
  const hasR2 = chunk.score     !== undefined;

  const passedCats  = chunk.reviewer1?.categories.filter(c => c.pass).length ?? 0;
  const totalCats   = chunk.reviewer1?.categories.length ?? 0;
  const certifiable = chunk.reviewer1?.certifiable ?? false;

  const tier = hasR2 ? scoreTier(chunk.score!) : null;

  const allIssues: Array<{ source: 'CERT' | 'STYLE'; text: string }> = [
    ...(chunk.reviewer1?.pitfalls.map(p => ({ source: 'CERT' as const, text: p })) ?? []),
    ...(chunk.issues?.map(i => ({ source: 'STYLE' as const, text: i })) ?? []),
  ];

  const displayText = chunk.revised || chunk.translation || '';

  return (
    <div style={{ background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 12 }} className="fadein">

      {/* ── Header — always visible, click to toggle ── */}
      <div
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 18px', background: 'var(--bg)', cursor: 'pointer', borderBottom: expanded ? '1px solid var(--border-light)' : 'none', userSelect: 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
          <span style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 13, color: 'var(--text-light)', letterSpacing: 1, flexShrink: 0 }}>Chunk {chunk.index + 1}</span>

          {/* Certification badge */}
          {hasR1 && (
            <span style={{
              fontSize: 10, fontWeight: 600, letterSpacing: 0.5, flexShrink: 0,
              color: certifiable ? 'var(--green)' : totalCats > 0 ? 'var(--amber)' : 'var(--text-light)',
            }}>
              {certifiable ? '✓ Certified' : totalCats > 0 ? `${passedCats}/${totalCats} categories` : 'Auditing…'}
            </span>
          )}
          {!hasR1 && !hasR2 && displayText && (
            <span style={{ fontSize: 13, fontWeight: 300, color: 'var(--text-muted)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
              {displayText.slice(0, 80)}{displayText.length > 80 ? '…' : ''}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {hasR2 && tier && (
            <>
              <span style={{ fontFamily: "'Karla', sans-serif", fontSize: 12, fontWeight: 700, color: tier.type === 'strong' ? 'var(--green)' : tier.type === 'adequate' ? 'var(--amber)' : 'var(--red)' }}>
                {chunk.score}%
              </span>
              <span style={badgeStyle(tier.type)}>{tier.label}</span>
            </>
          )}
          {allIssues.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--amber)', fontWeight: 500 }}>
              {allIssues.length} issue{allIssues.length !== 1 ? 's' : ''}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-light)', marginLeft: 2 }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Collapsed preview ── */}
      {!expanded && displayText && (
        <div style={{ padding: '10px 18px', fontSize: 13, fontWeight: 300, color: 'var(--text-muted)', lineHeight: 1.65 }}>
          {displayText.slice(0, 160)}{displayText.length > 160 ? '…' : ''}
        </div>
      )}

      {/* ── Expanded detail ── */}
      {expanded && (
        <div style={{ padding: '0 18px 20px' }}>

          {/* Score explanation */}
          {hasR2 && tier && (
            <div style={{ padding: '14px 0 14px', borderBottom: '1px solid var(--border-light)', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ ...labelStyle, marginBottom: 0 }}>Quality Score — Reviewer 2</span>
                <span style={{ fontFamily: "'Karla', sans-serif", fontSize: 20, fontWeight: 700, color: tier.type === 'strong' ? 'var(--green)' : tier.type === 'adequate' ? 'var(--amber)' : 'var(--red)' }}>
                  {chunk.score}%
                </span>
                <span style={badgeStyle(tier.type)}>{tier.label}</span>
              </div>
              <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginBottom: 8 }}>
                <div style={{ height: '100%', borderRadius: 2, width: `${chunk.score}%`, background: tier.type === 'strong' ? 'var(--green)' : tier.type === 'adequate' ? 'var(--amber)' : 'var(--red)', transition: 'width 0.5s' }} />
              </div>
              <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--text-light)', lineHeight: 1.55 }}>
                {tier.desc}{' '}
                <span style={{ color: 'var(--text-muted)' }}>Reviewer 2 scores terminology, punctuation, tone, and historical accuracy against 79+ BAPS correction examples. ≥85% meets publication standard.</span>
              </div>
            </div>
          )}

          {/* Certification audit grid */}
          {hasR1 && (chunk.reviewer1!.categories.length > 0 || chunk.reviewer1!.pitfalls.length > 0) && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ ...labelStyle, marginBottom: 0 }}>Certification Audit — Reviewer 1</span>
                {certifiable
                  ? <span style={badgeStyle('strong')}>✓ Certified</span>
                  : <span style={badgeStyle('adequate')}>{passedCats}/{totalCats} passed</span>
                }
              </div>
              {chunk.reviewer1!.categories.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '6px 16px', marginBottom: 8 }}>
                  {chunk.reviewer1!.categories.map(cat => (
                    <div key={cat.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                      <span style={{ fontSize: 13, color: cat.pass ? 'var(--green)' : 'var(--red)', flexShrink: 0, lineHeight: '18px' }}>{cat.pass ? '✓' : '✗'}</span>
                      <div>
                        <span style={{ fontSize: 12, fontWeight: cat.pass ? 300 : 600, color: cat.pass ? 'var(--text-muted)' : 'var(--text)' }}>{cat.name}</span>
                        {!cat.pass && cat.issues.map((iss, j) => (
                          <div key={j} style={{ fontSize: 11, color: 'var(--red)', fontWeight: 300, lineHeight: 1.4 }}>{iss}</div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Issues */}
          {allIssues.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ ...labelStyle, marginBottom: 10 }}>Issues Found &amp; Corrected ({allIssues.length})</div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {allIssues.map((issue, i) => (
                  <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: 0.8, padding: '2px 6px', borderRadius: 2, flexShrink: 0, marginTop: 3,
                      background: issue.source === 'CERT' ? 'var(--amber-bg)' : 'var(--bg-warm)',
                      color:      issue.source === 'CERT' ? 'var(--amber)' : 'var(--text-light)',
                      border:     `1px solid ${issue.source === 'CERT' ? 'var(--amber-border)' : 'var(--border)'}`,
                    }}>
                      {issue.source}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 300, color: 'var(--text-muted)', lineHeight: 1.65 }}>{issue.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Final translation */}
          {displayText && (
            <div>
              <div style={{ ...labelStyle, marginBottom: 8 }}>Final Translation</div>
              <div style={{ fontSize: 14, fontWeight: 300, color: 'var(--text-body)', lineHeight: 1.85, whiteSpace: 'pre-wrap', padding: '14px 16px', background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border-light)' }}>
                {displayText}
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
  const { user, loading, signOut, getIdToken } = useAuth();
  const router = useRouter();

  const [tab, setTab]             = useState<Tab>('input');
  const [inputMode, setInputMode] = useState<InputMode>('paste');
  const [inputText, setInputText] = useState('');
  const [uploadedFilename, setUploadedFilename] = useState('');
  const [stages, setStages]       = useState<StageState[]>(INITIAL_STAGES);
  const [chunks, setChunks]       = useState<ChunkData[]>([]);
  const [expandedChunks, setExpandedChunks] = useState<Set<number>>(new Set());
  const [output, setOutput]       = useState('');
  const [outputMeta, setOutputMeta] = useState({ words: 0, chunkCount: 0, avg: 0 });
  const [isRunning, setIsRunning] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [copied, setCopied]       = useState(false);

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

  const updateStage = useCallback((id: string, updates: Partial<StageState>) => {
    setStages(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);

  const toggleChunk = useCallback((i: number) => {
    setExpandedChunks(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  }, []);

  const words = wc(inputText);

  // ── Run a single section through the pipeline ──────────────────────────────

  const runSection = async (text: string, chapterTitle?: string, bookId?: string, chapterIndex?: number, totalChapters?: number): Promise<{ output: string; avg: number; wordCount: number } | null> => {
    setStages(INITIAL_STAGES);
    setChunks([]);
    setExpandedChunks(new Set());
    chunkMap.current = {};

    const token = await getIdToken();
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text, chapterTitle, bookId, chapterIndex, totalChapters, bookTitle: uploadedFilename || undefined }),
      signal: abortRef.current?.signal,
    });

    if (!response.ok) {
      const err = await response.text().catch(() => `HTTP ${response.status}`);
      throw new Error(err);
    }
    if (!response.body) throw new Error('No stream body');

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    let streamError: string | null = null;
    let result: { output: string; avg: number; wordCount: number } | null = null;

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }

        if (ev.error) { streamError = ev.error as string; break outer; }

        // ── Chunker ───────────────────────────────────────────────────
        if (ev.stage === 'chunker') {
          if (ev.status === 'running') {
            updateStage('chunker', { status: 'running', msg: 'Analysing structure and verse boundaries…' });
          } else if (ev.status === 'done') {
            const n = ev.count as number;
            updateStage('chunker', { status: 'done', msg: `Split into ${n} chunk${n !== 1 ? 's' : ''} at paragraph/verse boundaries`, progress: 100 });
            (ev.chunks as string[]).forEach((t, i) => { chunkMap.current[i] = { index: i, original: t }; });
            setChunks((ev.chunks as string[]).map((t, i) => ({ index: i, original: t })));
          }
        }

        // ── Translator ────────────────────────────────────────────────
        if (ev.stage === 'translator') {
          if (ev.status === 'running') {
            updateStage('translator', { status: 'running', msg: 'Applying gold standard glossary and house rules…', progress: 0 });
          } else if (ev.status === 'progress') {
            const cur = ev.current as number, tot = ev.total as number;
            updateStage('translator', { status: 'running', msg: `Translating chunk ${cur} of ${tot} — trustee-of-tradition mindset…`, progress: Math.round((cur - 1) / tot * 100) });
            const idx = ev.index as number;
            chunkMap.current[idx] = { ...chunkMap.current[idx], translation: ev.translation as string };
            setChunks(Object.values(chunkMap.current).sort((a, b) => a.index - b.index));
          } else if (ev.status === 'done') {
            updateStage('translator', { status: 'done', msg: 'All chunks translated with cross-chunk memory', progress: 100 });
          }
        }

        // ── Reviewer (combined cert + style) — parallel ─────────────
        if (ev.stage === 'reviewer') {
          if (ev.status === 'running') {
            updateStage('reviewer', { status: 'running', msg: 'Running BAPS certification + style audit (parallel)\u2026', progress: 0 });
          } else if (ev.status === 'rechecking') {
            const n = ev.count as number, round = ev.round as number;
            updateStage('reviewer', { status: 'running', msg: `Re-reviewing ${n} chunk${n !== 1 ? 's' : ''} scoring below 93% (round ${round})\u2026` });
          } else if (ev.status === 'progress') {
            const done = ev.completed as number, tot = ev.total as number;
            const recheck = ev.recheck as boolean | undefined;
            updateStage('reviewer', { status: 'running', msg: recheck ? `Re-reviewed chunk \u2014 correcting issues\u2026` : `Reviewed ${done} of ${tot} chunks\u2026`, progress: Math.round(done / tot * 100) });
            const idx = ev.index as number;
            chunkMap.current[idx] = {
              ...chunkMap.current[idx],
              reviewer1: {
                categories:  ev.categories  as Reviewer1Category[],
                pitfalls:    ev.pitfalls    as string[],
                score:       ev.score       as number,
                certifiable: ev.certifiable as boolean,
              },
              score: ev.score as number,
              issues: ev.issues as string[],
              revised: ev.revised as string,
              approved: (ev.score as number) >= 93,
            };
            setChunks(Object.values(chunkMap.current).sort((a, b) => a.index - b.index));
          } else if (ev.status === 'done') {
            const avg = Math.round(ev.avgScore as number);
            const certCount = ev.certCount as number, total = ev.total as number;
            const rechecked = ev.rechecked as number;
            updateStage('reviewer', { status: 'done', msg: `Review complete \u2014 ${certCount}/${total} certified, avg ${avg}%${rechecked > 0 ? ` (${rechecked} re-reviewed)` : ''}`, progress: 100 });
          }
        }

        // ── Smoother — parallel ─────────────────────────────────────
        if (ev.stage === 'smoother') {
          if (ev.status === 'running') {
            updateStage('smoother', { status: 'running', msg: 'Readability pass (parallel)…', progress: 0 });
          } else if (ev.status === 'progress') {
            const done = ev.completed as number, tot = ev.total as number;
            updateStage('smoother', { status: 'running', msg: `Smoothed ${done} of ${tot} chunks…`, progress: Math.round(done / tot * 100) });
          } else if (ev.status === 'done') {
            updateStage('smoother', { status: 'done', msg: 'Readability pass complete', progress: 100 });
          }
        }

        // ── Assembler ─────────────────────────────────────────────────
        if (ev.stage === 'assembler') {
          if (ev.status === 'running') {
            updateStage('assembler', { status: 'running', msg: 'Assembling all chunks into a single publication-ready document…' });
          } else if (ev.status === 'done') {
            const wCount = ev.wordCount as number, avg = ev.avgScore as number;
            updateStage('assembler', { status: 'done', msg: `Document assembled — ${wCount.toLocaleString()} words · avg score ${avg}%` });
            result = { output: ev.output as string, avg, wordCount: wCount };
          }
        }
      }
    }

    if (streamError) throw new Error(streamError);
    return result;
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
    setIsRunning(true);
    setTab('pipeline');
    abortRef.current = new AbortController();

    try {
      if (isBookMode && bookChapters.length > 0) {
        const bookRunId = crypto.randomUUID();
        const allOutputs: string[] = new Array(bookChapters.length).fill('');
        const chapterLines = inputText.split('\n');

        for (let i = 0; i < bookChapters.length; i++) {
          setCurrentChapterIdx(i);
          setBookChapters(prev => prev.map((c, j) => j === i ? { ...c, status: 'running' } : c));

          const start  = bookChapters[i].startLine ?? 0;
          const end    = bookChapters[i + 1]?.startLine ?? chapterLines.length;
          const chText = chapterLines.slice(start, end).join('\n').trim();

          if (!chText) {
            setBookChapters(prev => prev.map((c, j) => j === i ? { ...c, status: 'done', output: '' } : c));
            continue;
          }

          try {
            const res = await runSection(chText, bookChapters[i].title, bookRunId, i, bookChapters.length);
            if (res) {
              allOutputs[i] = res.output;
              setBookOutputs([...allOutputs]);
              setBookChapters(prev => prev.map((c, j) => j === i ? { ...c, status: 'done', output: res.output, avgScore: res.avg, wordCount: res.wordCount } : c));
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Error';
            setBookChapters(prev => prev.map((c, j) => j === i ? { ...c, status: 'error' } : c));
            setPipelineError(`Chapter "${bookChapters[i].title}" failed: ${msg}`);
            break;
          }
        }

        const combined = allOutputs.filter(Boolean).join('\n\n');
        setOutput(combined);
        setOutputMeta({ words: wc(combined), chunkCount: bookChapters.length, avg: Math.round(bookChapters.filter(c => c.avgScore).reduce((s, c) => s + (c.avgScore ?? 0), 0) / Math.max(1, bookChapters.filter(c => c.avgScore).length)) });
        if (combined) setTimeout(() => setTab('output'), 400);

      } else {
        const res = await runSection(inputText);
        if (res) {
          setOutput(res.output);
          setOutputMeta({ words: res.wordCount, chunkCount: Object.keys(chunkMap.current).length, avg: res.avg });
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

  const handleDownload = () => {
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: `${uploadedFilename ? uploadedFilename.replace(/\.[^.]+$/, '') : 'translation'}-en.txt` });
    a.click();
    URL.revokeObjectURL(url);
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
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 20, color: 'var(--text-muted)', fontStyle: 'italic' }}>Loading…</div>
      </div>
    );
  }

  const errorBanner = pipelineError && (
    <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '14px 18px', fontSize: 13, color: 'var(--red)', fontWeight: 300, marginBottom: 20 }}>
      <strong style={{ fontWeight: 600 }}>Error: </strong>{pipelineError}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>

      {/* Header */}
      <header ref={headerRef} style={{ background: 'var(--bg-white)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 100, padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 3, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 2 }}>
            BAPS Swaminarayan · Aksharpith
          </div>
          <div style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 300, fontSize: 26, color: 'var(--text)', letterSpacing: '-0.3px' }}>
            Translation <em>Pipeline</em>
            <span style={{ fontFamily: "'Karla', sans-serif", fontSize: 10, fontWeight: 600, letterSpacing: 1, color: 'var(--text-light)', marginLeft: 12, verticalAlign: 'middle' }}>
              6 AGENTS · GOLD STANDARD
            </span>
          </div>
        </div>
        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 300 }}>{user.email}</span>
            <button onClick={() => router.push('/history')} style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-light)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontFamily: "'Karla', sans-serif" }}>
              History
            </button>
            <button onClick={signOut} style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-light)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontFamily: "'Karla', sans-serif" }}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {/* Tabs */}
      <div style={{ display: 'flex', background: 'var(--bg-white)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 'var(--header-h, 67px)', zIndex: 99 }}>
        {(['input', 'pipeline', 'output'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: '12px 8px',
            fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600,
            letterSpacing: '1.5px', textTransform: 'uppercase', textAlign: 'center',
            cursor: 'pointer', border: 'none', background: 'transparent',
            color: tab === t ? 'var(--text)' : 'var(--text-light)',
            borderBottom: `2px solid ${tab === t ? 'var(--text)' : 'transparent'}`,
            transition: 'all 0.2s',
          }}>
            {t}{t === 'output' && output ? ' ✓' : ''}
          </button>
        ))}
      </div>

      {/* ── INPUT TAB ── */}
      {tab === 'input' && (
        <div style={{ padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 780, margin: '0 auto', width: '100%' }}>

          {errorBanner}

          {/* Input mode toggle */}
          <div style={{ display: 'flex', gap: 0, background: 'var(--bg-warm)', borderRadius: 'var(--radius)', padding: 3, border: '1px solid var(--border)' }}>
            {(['paste', 'upload'] as InputMode[]).map(m => (
              <button key={m} onClick={() => setInputMode(m)} style={{
                flex: 1, padding: '9px 12px', border: 'none', borderRadius: 6,
                background: inputMode === m ? 'var(--bg-white)' : 'transparent',
                boxShadow: inputMode === m ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600,
                letterSpacing: '1px', textTransform: 'uppercase',
                color: inputMode === m ? 'var(--text)' : 'var(--text-light)',
                cursor: 'pointer', transition: 'all 0.2s',
              }}>
                {m === 'paste' ? 'Paste Text' : 'Upload File'}
              </button>
            ))}
          </div>

          {/* Source input */}
          <div style={{ background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '22px 24px' }}>
            <div style={labelStyle}>{inputMode === 'paste' ? 'Gujarati Source Text' : 'Upload Document'}</div>

            {inputMode === 'upload' ? (
              <>
                <FileUpload onExtracted={handleFileExtracted} disabled={isRunning} getToken={getIdToken} />
                {inputText && (
                  <div style={{ marginTop: 14, padding: '12px 16px', background: 'var(--bg-warm)', border: '1px solid var(--border)', borderRadius: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--green)', marginBottom: 4 }}>
                      ✓ Extracted — {uploadedFilename}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {words.toLocaleString()} words
                      {isBookMode && bookChapters.length > 0 && ` · ${bookChapters.length} sections detected — book mode active`}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 6, fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', lineHeight: 1.5 }}>
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
                  style={{
                    width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                    padding: 14, fontSize: 17, fontWeight: 400, color: 'var(--text)', lineHeight: 1.8,
                    outline: 'none', resize: 'vertical', minHeight: 200, marginTop: 8, transition: 'border-color 0.2s',
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                  <button onClick={() => setInputText(SAMPLE)} style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-light)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    Load sample →
                  </button>
                  <div style={{ fontSize: 11, fontWeight: 400, color: words > MAX_WORDS ? 'var(--red)' : 'var(--text-light)' }}>
                    {words.toLocaleString()} / {MAX_WORDS.toLocaleString()} words{words > MAX_WORDS ? ' — too long' : words > WARN_WORDS ? ' — use book mode' : ''}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Book mode panel */}
          {isBookMode && bookChapters.length > 0 && (
            <div style={{ background: 'var(--green-bg)', border: '1px solid var(--green-border)', borderRadius: 'var(--radius)', padding: '18px 22px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 18, color: 'var(--text)' }}>Book Mode</div>
                <span style={badgeStyle('strong')}>{bookChapters.length} sections</span>
              </div>
              <div style={{ fontSize: 12, fontWeight: 300, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Each section will be processed as a separate 6-agent pipeline run. Translation memory is maintained across sections.
              </div>
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {bookChapters.slice(0, 8).map((ch, i) => (
                  <div key={i} style={{ fontSize: 12, fontWeight: 300, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--text-light)', width: 20, flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
                    {ch.title}
                  </div>
                ))}
                {bookChapters.length > 8 && <div style={{ fontSize: 12, color: 'var(--text-light)' }}>+{bookChapters.length - 8} more…</div>}
              </div>
              <button onClick={() => { setIsBookMode(false); setBookChapters([]); }} style={{ marginTop: 12, fontSize: 11, fontWeight: 500, color: 'var(--green)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                Switch to single-section mode
              </button>
            </div>
          )}

          {/* Gold Standard context active */}
          <div style={{ background: 'var(--bg-warm)', borderLeft: '2px solid var(--text-light)', borderRadius: '0 var(--radius) var(--radius) 0', padding: '20px 24px' }}>
            <div style={{ ...labelStyle, marginBottom: 10 }}>Gold Standard Context Active</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                'Aksharpith House Rules (full)',
                'Master Glossary (200+ terms)',
                'BAPS Certification Checklist',
                'BAPS Common Pitfalls (20 items)',
                '79+ before/after corrections',
                'Cross-chunk translation memory',
              ].map(rule => (
                <div key={rule} style={{ fontSize: 13, fontWeight: 300, color: 'var(--text-muted)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--green)', fontWeight: 500, flexShrink: 0 }}>✓</span>
                  {rule}
                </div>
              ))}
            </div>
          </div>

          {/* Run button */}
          <button
            onClick={isRunning ? handleStop : handleRun}
            disabled={!isRunning && !inputText.trim()}
            style={{
              width: '100%', padding: '16px 24px',
              border: `1px solid ${isRunning ? 'var(--border)' : !inputText.trim() ? 'var(--border)' : 'var(--text)'}`,
              borderRadius: 'var(--radius)',
              background: isRunning ? 'var(--bg-white)' : !inputText.trim() ? 'var(--bg-warm)' : 'var(--text)',
              color: isRunning ? 'var(--text-muted)' : !inputText.trim() ? 'var(--text-light)' : 'var(--bg-white)',
              fontFamily: '"Cormorant Garamond", serif', fontSize: 20, fontWeight: 400,
              letterSpacing: '0.3px', cursor: (!isRunning && !inputText.trim()) ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {isRunning
              ? `${isBookMode ? `Processing section ${currentChapterIdx + 1} of ${bookChapters.length}` : 'Pipeline running'}… (click to stop)`
              : `Run ${isBookMode ? 'Book' : ''} Translation Pipeline →`}
          </button>
        </div>
      )}

      {/* ── PIPELINE TAB ── */}
      {tab === 'pipeline' && (
        <div style={{ padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 0, maxWidth: 780, margin: '0 auto', width: '100%' }}>

          {errorBanner}

          {isBookMode && <ChapterBar chapters={bookChapters} />}

          {/* Stage cards */}
          {stages.map((stage, i) => (
            <div key={stage.id}>
              <StageCard stage={stage} />
              {i < stages.length - 1 && <div style={{ width: 1, height: 8, background: 'var(--border)', marginLeft: 18 }} />}
            </div>
          ))}

          {/* Chunk detail */}
          {chunks.length > 0 && (
            <div style={{ marginTop: 36 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 4 }}>
                <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 24, fontWeight: 400, color: 'var(--text)' }}>
                  Chunk Detail
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-light)', fontWeight: 300 }}>Click any chunk to expand</span>
              </div>
              <div style={{ width: 48, height: 1, background: 'var(--border)', margin: '8px 0 16px' }} />

              {/* Score legend */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginBottom: 16, padding: '10px 14px', background: 'var(--bg-warm)', borderRadius: 6, border: '1px solid var(--border)' }}>
                <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1.5, textTransform: 'uppercase', color: 'var(--text-light)', width: '100%', marginBottom: 4 }}>Score Guide — Reviewer 2</span>
                {[
                  { label: '90–100%', name: 'Publication Ready', type: 'strong' as const },
                  { label: '80–89%',  name: 'Strong',            type: 'strong' as const },
                  { label: '70–79%',  name: 'Revised',           type: 'adequate' as const },
                  { label: '60–69%',  name: 'Needs Work',        type: 'adequate' as const },
                  { label: '<60%',    name: 'Poor',              type: 'weak' as const },
                ].map(s => (
                  <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-light)', fontWeight: 300 }}>{s.label}</span>
                    <span style={badgeStyle(s.type)}>{s.name}</span>
                  </div>
                ))}
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

      {/* ── OUTPUT TAB ── */}
      {tab === 'output' && (
        <div style={{ padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 780, margin: '0 auto', width: '100%' }}>
          {!output ? (
            <div style={{ textAlign: 'center', padding: '48px 20px' }}>
              <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 24, fontWeight: 300, fontStyle: 'italic', marginBottom: 8, color: 'var(--text-muted)' }}>
                {isRunning ? <span className="spinning">◌</span> : 'No translation yet'}
              </div>
              <p style={{ fontSize: 13, fontWeight: 300, color: 'var(--text-light)' }}>
                {isRunning ? 'Processing your text…' : 'Run the pipeline to see output here'}
              </p>
            </div>
          ) : (
            <>
              <div>
                <div style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 300, fontSize: 28, color: 'var(--text)', letterSpacing: '-0.3px' }}>Final Translation</div>
                <div style={{ fontSize: 12, fontWeight: 300, color: 'var(--text-muted)', marginTop: 4 }}>
                  {outputMeta.words.toLocaleString()} words · {outputMeta.chunkCount} section{outputMeta.chunkCount !== 1 ? 's' : ''} · avg quality score {outputMeta.avg}%
                </div>
              </div>
              <div style={{ width: 48, height: 1, background: 'var(--border)' }} />
              <div style={{ background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 24, fontFamily: '"Cormorant Garamond", serif', fontSize: 17, fontWeight: 400, lineHeight: 1.9, color: 'var(--text-body)', whiteSpace: 'pre-wrap' }} className="fadein">
                {output}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={handleCopy} style={{ flex: 1, padding: '14px 24px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg-white)', color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1.5px', textTransform: 'uppercase', cursor: 'pointer', transition: 'all 0.2s' }}>
                  {copied ? 'Copied ✓' : 'Copy Full Translation'}
                </button>
                <button onClick={handleDownload} style={{ padding: '14px 20px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg-white)', color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: '1.5px', textTransform: 'uppercase', cursor: 'pointer', transition: 'all 0.2s' }}>
                  Download .txt
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
