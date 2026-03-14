'use client';

import { useState, useRef, useCallback } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

type StageStatus = 'waiting' | 'running' | 'done' | 'error';
type Tab = 'input' | 'pipeline' | 'output';

interface StageState {
  id: 'chunker' | 'translator' | 'reviewer' | 'assembler';
  num: string;
  label: string;
  tagline: string;
  status: StageStatus;
  msg: string;
  progress: number | null;
}

interface ChunkData {
  index: number;
  original: string;
  translation?: string;
  score?: number;
  issues?: string[];
  revised?: string;
  approved?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SAMPLE = `પ્રેમે પ્રગટ્યા રે સૂરજ સહજાનંદ, અધર્મ અંધારું ટાળિયું...

ભગવાન સ્વામિનારાયણના સમકાલીન અને તેઓના જ પરમહંસ-શિષ્ય સ્વામી મુક્તાનંદજીએ ગાયેલી આ પંક્તિ, અઢારમી સદીના ઘોર દુર્ભેદ્ય અંધકારને ઉલેચનાર ભગવાન સ્વામિનારાયણને ખૂબ ઉચિત અંજલિ અર્પે છે.

સને 1781માં ત્રીજી એપ્રિલે, અયોધ્યા પાસે છપિયા ગામે ઉચ્ચ સરવરિયા બ્રાહ્મણ કુળમાં પ્રગટેલા આ અવતારી પુરુષે, બાળવયમાં જ તીવ્ર બુદ્ધિમત્તા, વિદ્વત્તા અને દિવ્યતાનો અસાધારણ અનુભવ કરાવ્યો; માત્ર 11 જ વર્ષની કુમળી વયે ગૃહત્યાગ કર્યો.

'કેમ્બ્રિજ હિસ્ટરી આૅફ ગુજરાત'માં ઇતિહાસવિદ્‌ એચ. એચ. ડોડવેલ વર્ણવે છે : 'બધાં જ સ્તર પર વ્યાપેલો આવો સખત ત્રાસ ભારતમાં પૂર્વે ક્યારેય ન હતો. દેશી રાજ્યો અવ્યવસ્થિત હતાં. સમાજ વિસર્જનના આરે આવીને ઊભો હતો.'`;

const INITIAL_STAGES: StageState[] = [
  { id: 'chunker',    num: '01', label: 'Chunker',    tagline: 'Splits text at paragraph boundaries into ≤500-word chunks',          status: 'waiting', msg: '', progress: null },
  { id: 'translator', num: '02', label: 'Translator', tagline: 'Translates each chunk with full Aksharpith style context injected',    status: 'waiting', msg: '', progress: null },
  { id: 'reviewer',   num: '03', label: 'Reviewer',   tagline: 'Checks each translation against the style guide and BAPS glossary',   status: 'waiting', msg: '', progress: null },
  { id: 'assembler',  num: '04', label: 'Assembler',  tagline: 'Joins reviewed chunks into the final document',                       status: 'waiting', msg: '', progress: null },
];

const STYLE_CONTEXT = `You are an expert Gujarati-to-English translator working under the Aksharpith House Style Guide for BAPS Swaminarayan publications.

MANDATORY STYLE RULES:
1. BRITISH ENGLISH only — travelling, recognised, honour, colour, organisation
2. OXFORD PUNCTUATION — curly double speech marks (" "), spaced en dashes ( – ), Oxford comma
3. DIACRITICS — Use macrons (ā, ī, ū) ONLY in canonical/poetic verse transliterations. Plain spellings in prose.
4. TONE — Reverent, scholarly, formal. Never casual.
5. GLOSSARY (use exact forms):
   Bhagwan Swaminarayan (not "Lord Swaminarayan")
   Shriji Maharaj (two words)
   paramhansa (not "paramhamsa")
   austerities (not "penance")
   Swami (not "saint")
   bawa
   mandir (not "temple" unless quoting non-BAPS sources)
   satsang (not "fellowship")
6. PROPER NOUNS — Retain in standard BAPS romanisation
7. POETRY/VERSE — Transliterate with macrons; provide English meaning in parentheses
8. HISTORICAL ACCURACY — Preserve all dates, ages, place names exactly
9. SCRIPTURE — Never paraphrase; translate with maximum fidelity
10. FORMAT — Preserve paragraph breaks. Do not add headers unless present in source.

OUTPUT: Return ONLY the translated English text. No preamble, no compliance notes, no commentary.`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function wc(t: string) { return t.trim() ? t.trim().split(/\s+/).length : 0; }
function estimateChunks(t: string) { return Math.ceil(wc(t) / 500) || 0; }

const MAX_WORDS = 8000;

const labelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 8,
};

function scoreBadge(score: number | undefined, approved: boolean | undefined) {
  if (score === undefined) return null;
  if (score >= 85)  return { cls: 'badge-strong',   label: approved ? 'Approved' : 'Strong' };
  if (score >= 70)  return { cls: 'badge-adequate', label: 'Revised' };
  return              { cls: 'badge-weak',     label: 'Weak' };
}

// ── Stage Card ─────────────────────────────────────────────────────────────────

function StageCard({ stage }: { stage: StageState }) {
  const s = stage.status;

  const cardStyle: React.CSSProperties = {
    background: s === 'running' ? 'var(--amber-bg)'
              : s === 'done'    ? 'var(--green-bg)'
              : s === 'error'   ? 'var(--red-bg)'
              : 'var(--bg-white)',
    border: `1px solid ${
      s === 'running' ? 'var(--amber-border)'
    : s === 'done'    ? 'var(--green-border)'
    : s === 'error'   ? 'var(--red-border)'
    : 'var(--border)'}`,
    borderRadius: 'var(--radius)',
    padding: '18px 22px',
    transition: 'all 0.3s',
  };

  let badge: React.ReactNode = null;
  if (s === 'done')    badge = <span style={badgeStyle('strong')}>Done</span>;
  if (s === 'running') badge = <span style={badgeStyle('running')}>Running</span>;
  if (s === 'error')   badge = <span style={badgeStyle('weak')}>Error</span>;

  const msg = stage.msg || stage.tagline;

  return (
    <div style={cardStyle} className="fadein">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 13, letterSpacing: 1, color: 'var(--text-light)', width: 20 }}>
            {stage.num}
          </span>
          <span style={{
            fontFamily: '"Cormorant Garamond", serif', fontSize: 22, fontWeight: 400,
            color: (s === 'running' || s === 'done') ? 'var(--text)' : 'var(--text-muted)',
            transition: 'color 0.3s',
          }}>
            {stage.label}
          </span>
        </div>
        {badge}
      </div>
      <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--text-muted)', marginTop: 4, paddingLeft: 32, lineHeight: 1.6 }}>
        {msg}
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
    letterSpacing: '0.8px', textTransform: 'uppercase',
    padding: '3px 10px', borderRadius: 3, whiteSpace: 'nowrap',
    background: t.bg, color: t.color, border: `1px solid ${t.border}`,
  };
}

// ── Chunk Card ─────────────────────────────────────────────────────────────────

function ChunkCard({ chunk }: { chunk: ChunkData }) {
  const badge = scoreBadge(chunk.score, chunk.approved);
  const preview = (chunk.revised || chunk.translation || '').slice(0, 280);
  const hasMore = (chunk.revised || chunk.translation || '').length > 280;

  return (
    <div style={{ background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 12 }} className="fadein">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: '1px solid var(--border-light)', background: 'var(--bg)' }}>
        <span style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 13, color: 'var(--text-light)', letterSpacing: 1 }}>
          Chunk {chunk.index + 1}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {chunk.score !== undefined && (
            <span style={{ fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 500, color: chunk.score >= 85 ? 'var(--green)' : 'var(--amber)', marginRight: 8 }}>
              {chunk.score}%
            </span>
          )}
          {badge && <span style={badgeStyle(badge.cls as 'strong' | 'adequate' | 'weak' | 'running')}>{badge.label}</span>}
        </div>
      </div>
      <div style={{ padding: '16px 18px' }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase' as const, color: 'var(--text-light)', marginBottom: 8 }}>
          Translation
        </div>
        <div style={{ fontSize: 14, fontWeight: 300, color: 'var(--text-body)', lineHeight: 1.75 }}>
          {preview}{hasMore ? '…' : ''}
        </div>
        {chunk.issues && chunk.issues.length > 0 && (
          <>
            <ul style={{ listStyle: 'none', marginTop: 12, padding: 0 }}>
              {chunk.issues.map((issue, i) => (
                <li key={i} style={{ fontSize: 13, fontWeight: 300, color: 'var(--amber)', paddingLeft: 18, position: 'relative', lineHeight: 1.7, marginBottom: 6 }}>
                  <span style={{ position: 'absolute', left: 0 }}>—</span>
                  {issue}
                </li>
              ))}
            </ul>
            <div style={{ background: 'var(--bg-warm)', borderLeft: '2px solid var(--text-light)', padding: '16px 20px', marginTop: 14, borderRadius: '0 6px 6px 0' }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase' as const, color: 'var(--text-light)', marginBottom: 8 }}>
                Corrected by Reviewer
              </div>
              <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Issues above were resolved in the final output.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function Home() {
  const [tab, setTab]               = useState<Tab>('input');
  const [inputText, setInputText]   = useState('');
  const [stages, setStages]         = useState<StageState[]>(INITIAL_STAGES);
  const [chunks, setChunks]         = useState<ChunkData[]>([]);
  const [output, setOutput]         = useState('');
  const [outputMeta, setOutputMeta] = useState({ words: 0, chunkCount: 0, avg: 0 });
  const [isRunning, setIsRunning]   = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [copied, setCopied]         = useState(false);

  const abortRef  = useRef<AbortController | null>(null);
  const chunkMap  = useRef<Record<number, ChunkData>>({});

  const updateStage = useCallback((id: string, updates: Partial<StageState>) => {
    setStages(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);

  const handleRun = async () => {
    if (!inputText.trim() || isRunning) return;
    if (wc(inputText) > MAX_WORDS) {
      setPipelineError(`Input too long (${wc(inputText).toLocaleString()} words). Please keep under ${MAX_WORDS.toLocaleString()} words to avoid timeouts.`);
      return;
    }

    setStages(INITIAL_STAGES);
    setChunks([]);
    setOutput('');
    setPipelineError(null);
    chunkMap.current = {};
    setIsRunning(true);
    setTab('pipeline');

    abortRef.current = new AbortController();

    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: inputText, styleContext: STYLE_CONTEXT }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const err = await response.text().catch(() => `HTTP ${response.status}`);
        throw new Error(err);
      }
      if (!response.body) throw new Error('No stream body');

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';
      let   streamError: string | null = null;

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

          // Chunker
          if (ev.stage === 'chunker') {
            if (ev.status === 'running') {
              updateStage('chunker', { status: 'running', msg: 'Analysing text structure…' });
            } else if (ev.status === 'done') {
              const n = ev.count as number;
              updateStage('chunker', { status: 'done', msg: `Split into ${n} chunk${n !== 1 ? 's' : ''}`, progress: 100 });
              (ev.chunks as string[]).forEach((t, i) => { chunkMap.current[i] = { index: i, original: t }; });
              setChunks((ev.chunks as string[]).map((t, i) => ({ index: i, original: t })));
            }
          }

          // Translator
          if (ev.stage === 'translator') {
            if (ev.status === 'running') {
              updateStage('translator', { status: 'running', msg: 'Starting…', progress: 0 });
            } else if (ev.status === 'progress') {
              const cur = ev.current as number, tot = ev.total as number;
              updateStage('translator', { status: 'running', msg: `Translating chunk ${cur} of ${tot}…`, progress: Math.round((cur - 1) / tot * 100) });
              const idx = ev.index as number;
              chunkMap.current[idx] = { ...chunkMap.current[idx], translation: ev.translation as string };
              setChunks(Object.values(chunkMap.current).sort((a, b) => a.index - b.index));
            } else if (ev.status === 'done') {
              updateStage('translator', { status: 'done', msg: 'All chunks translated', progress: 100 });
            }
          }

          // Reviewer
          if (ev.stage === 'reviewer') {
            if (ev.status === 'running') {
              updateStage('reviewer', { status: 'running', msg: 'Starting review…', progress: 0 });
            } else if (ev.status === 'progress') {
              const chk = ev.chunk as number;
              const tot = Object.keys(chunkMap.current).length;
              updateStage('reviewer', { status: 'running', msg: `Reviewing chunk ${chk} of ${tot}…`, progress: Math.round((chk - 1) / tot * 100) });
              const idx = ev.index as number;
              chunkMap.current[idx] = { ...chunkMap.current[idx], score: ev.score as number, issues: ev.issues as string[], revised: ev.revised as string, approved: (ev.score as number) >= 85 };
              setChunks(Object.values(chunkMap.current).sort((a, b) => a.index - b.index));
            } else if (ev.status === 'done') {
              const avg = Math.round(ev.avgScore as number);
              updateStage('reviewer', { status: 'done', msg: `All chunks reviewed — average score ${avg}%`, progress: 100 });
            }
          }

          // Assembler
          if (ev.stage === 'assembler') {
            if (ev.status === 'running') {
              updateStage('assembler', { status: 'running', msg: 'Assembling final document…' });
            } else if (ev.status === 'done') {
              updateStage('assembler', { status: 'done', msg: 'Document assembled and ready' });
              const finalText = ev.output as string;
              const allChunks = Object.values(chunkMap.current);
              const avg = allChunks.length
                ? Math.round(allChunks.reduce((s, c) => s + (c.score ?? 85), 0) / allChunks.length)
                : 0;
              setOutput(finalText);
              setOutputMeta({ words: wc(finalText), chunkCount: allChunks.length, avg });
              setTimeout(() => setTab('output'), 400);
            }
          }
        }
      }

      if (streamError) {
        setPipelineError(streamError);
        setStages(prev => prev.map(s => s.status === 'running' ? { ...s, status: 'error', msg: streamError! } : s));
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

  const handleStop = () => abortRef.current?.abort();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'aksharpith-translation.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };

  const words  = wc(inputText);
  const nchunks = estimateChunks(inputText);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>

      {/* Header */}
      <header ref={el => { if (el) document.documentElement.style.setProperty('--header-h', el.offsetHeight + 'px'); }} style={{ background: 'var(--bg-white)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 100, padding: '14px 20px' }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 3, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 2 }}>
          BAPS Swaminarayan · Aksharpith
        </div>
        <div style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 300, fontSize: 26, color: 'var(--text)', letterSpacing: '-0.3px' }}>
          Translation <em>Pipeline</em>
        </div>
      </header>

      {/* Tabs */}
      <div style={{ display: 'flex', background: 'var(--bg-white)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 'var(--header-h, 67px)', zIndex: 99 }}>
        {(['input', 'pipeline', 'output'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '12px 8px',
              fontFamily: "'Karla', sans-serif", fontSize: 11, fontWeight: 600,
              letterSpacing: '1.5px', textTransform: 'uppercase', textAlign: 'center',
              cursor: 'pointer', border: 'none', background: 'transparent',
              color: tab === t ? 'var(--text)' : 'var(--text-light)',
              borderBottom: `2px solid ${tab === t ? 'var(--text)' : 'transparent'}`,
              transition: 'all 0.2s',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── INPUT TAB ── */}
      {tab === 'input' && (
        <div style={{ padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 780, margin: '0 auto', width: '100%' }}>

          {/* Source text */}
          <div style={{ background: 'var(--bg-white)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '22px 24px' }}>
            <div style={labelStyle}>Gujarati Source Text</div>
            <textarea
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder="Paste Gujarati text here — any length…"
              disabled={isRunning}
              style={{
                width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                padding: 14, fontSize: 17, fontWeight: 400, color: 'var(--text)', lineHeight: 1.8,
                outline: 'none', resize: 'vertical', minHeight: 200, transition: 'border-color 0.2s',
                marginTop: 8,
              }}
            />
            <div style={{ fontSize: 11, fontWeight: 400, color: words > MAX_WORDS ? 'var(--red)' : 'var(--text-light)', textAlign: 'right', marginTop: 8 }}>
              {words.toLocaleString()} / {MAX_WORDS.toLocaleString()} words · {nchunks} chunk{nchunks !== 1 ? 's' : ''}
              {words > MAX_WORDS && ' — too long'}
            </div>
          </div>

          {/* Style rules summary */}
          <div style={{ background: 'var(--bg-warm)', borderLeft: '2px solid var(--text-light)', borderRadius: '0 var(--radius) var(--radius) 0', padding: '20px 24px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase' as const, color: 'var(--text-light)', marginBottom: 8 }}>
              Aksharpith Style Rules Active
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
              {[
                'British English (Oxford)',
                'Curly quotes & en dashes',
                'Macrons in verse only',
                'Reverent scholarly tone',
                'BAPS glossary enforced',
                'Historical accuracy kept',
              ].map(rule => (
                <div key={rule} style={{ fontSize: 13, fontWeight: 300, color: 'var(--text-muted)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--green)', fontWeight: 500, flexShrink: 0 }}>✓</span>
                  {rule}
                </div>
              ))}
            </div>
          </div>

          {/* Error */}
          {pipelineError && (
            <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '14px 18px', fontSize: 13, color: 'var(--red)', fontWeight: 300 }}>
              <strong style={{ fontWeight: 600 }}>Error: </strong>{pipelineError}
            </div>
          )}

          {/* Run button */}
          <button
            onClick={isRunning ? handleStop : handleRun}
            disabled={!isRunning && !inputText.trim()}
            style={{
              width: '100%', padding: '16px 24px',
              border: `1px solid ${isRunning ? 'var(--border)' : !inputText.trim() ? 'var(--border)' : 'var(--text)'}`,
              borderRadius: 'var(--radius)',
              background: isRunning ? 'var(--bg-white)'
                        : !inputText.trim() ? 'var(--bg-warm)'
                        : 'var(--text)',
              color: isRunning ? 'var(--text-muted)'
                   : !inputText.trim() ? 'var(--text-light)'
                   : 'var(--bg-white)',
              fontFamily: '"Cormorant Garamond", serif', fontSize: 20, fontWeight: 400,
              letterSpacing: '0.3px', cursor: (!isRunning && !inputText.trim()) ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {isRunning ? 'Pipeline running… (click to stop)' : 'Run Translation Pipeline →'}
          </button>
        </div>
      )}

      {/* ── PIPELINE TAB ── */}
      {tab === 'pipeline' && (
        <div style={{ padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 0, maxWidth: 780, margin: '0 auto', width: '100%' }}>

          {/* Error banner */}
          {pipelineError && (
            <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '14px 18px', fontSize: 13, color: 'var(--red)', fontWeight: 300, marginBottom: 20 }}>
              <strong style={{ fontWeight: 600 }}>Error: </strong>{pipelineError}
            </div>
          )}

          {/* Stage cards */}
          {stages.map((stage, i) => (
            <div key={stage.id}>
              <StageCard stage={stage} />
              {i < stages.length - 1 && (
                <div style={{ width: 1, height: 8, background: 'var(--border)', marginLeft: 18 }} />
              )}
            </div>
          ))}

          {/* Chunk details */}
          {chunks.length > 0 && (
            <div style={{ marginTop: 32 }}>
              <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 24, fontWeight: 400, color: 'var(--text)', marginBottom: 4, marginTop: 8 }}>
                Chunk Detail
              </div>
              <div style={{ width: 48, height: 1, background: 'var(--border)', margin: '8px 0 16px' }} />
              {chunks.map(chunk => <ChunkCard key={chunk.index} chunk={chunk} />)}
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
                {isRunning ? 'Processing your text…' : 'Run the pipeline to see your output here'}
              </p>
            </div>
          ) : (
            <>
              <div>
                <div style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 300, fontSize: 28, color: 'var(--text)', letterSpacing: '-0.3px' }}>
                  Final Translation
                </div>
                <div style={{ fontSize: 12, fontWeight: 300, color: 'var(--text-muted)', marginTop: 4 }}>
                  {outputMeta.words.toLocaleString()} words · {outputMeta.chunkCount} chunk{outputMeta.chunkCount !== 1 ? 's' : ''} · average score {outputMeta.avg}%
                </div>
              </div>

              <div style={{ width: 48, height: 1, background: 'var(--border)', margin: '0 0 4px' }} />

              <div style={{
                background: 'var(--bg-white)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', padding: 24,
                fontFamily: '"Cormorant Garamond", serif', fontSize: 17, fontWeight: 400,
                lineHeight: 1.9, color: 'var(--text-body)', whiteSpace: 'pre-wrap',
              }} className="fadein">
                {output}
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={handleCopy}
                  style={{
                    flex: 1, padding: '14px 24px', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', background: 'var(--bg-white)',
                    color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif",
                    fontSize: 11, fontWeight: 600, letterSpacing: '1.5px', textTransform: 'uppercase',
                    cursor: 'pointer', transition: 'all 0.2s',
                  }}
                >
                  {copied ? 'Copied ✓' : 'Copy Full Translation'}
                </button>
                <button
                  onClick={handleDownload}
                  style={{
                    padding: '14px 20px', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', background: 'var(--bg-white)',
                    color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif",
                    fontSize: 11, fontWeight: 600, letterSpacing: '1.5px', textTransform: 'uppercase',
                    cursor: 'pointer', transition: 'all 0.2s',
                  }}
                >
                  Download
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
