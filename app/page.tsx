'use client';

import { useState, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type StageStatus = 'waiting' | 'running' | 'done' | 'error';

interface StageState {
  id: 'chunker' | 'translator' | 'reviewer' | 'assembler';
  label: string;
  tagline: string;
  status: StageStatus;
  detail: string;
}

interface ChunkData {
  index: number;
  original: string;
  translation?: string;
  score?: number;
  issues?: string[];
  revised?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SAMPLE_GUJARATI = `પ્રેમે પ્રગટ્યા રે સૂરજ સહજાનંદ, અધર્મ અંધારું ટાળિયું...

ભગવાન સ્વામિનારાયણના સમકાલીન અને તેઓના જ પરમહંસ-શિષ્ય સ્વામી મુક્તાનંદજીએ ગાયેલી આ પંક્તિ, અઢારમી સદીના ઘોર દુર્ભેદ્ય અંધકારને ઉલેચનાર ભગવાન સ્વામિનારાયણને ખૂબ ઉચિત અંજલિ અર્પે છે.

સને 1781માં ત્રીજી એપ્રિલે, અયોધ્યા પાસે છપિયા ગામે ઉચ્ચ સરવરિયા બ્રાહ્મણ કુળમાં પ્રગટેલા આ અવતારી પુરુષે, બાળવયમાં જ તીવ્ર બુદ્ધિમત્તા, વિદ્વત્તા અને દિવ્યતાનો અસાધારણ અનુભવ કરાવ્યો; માત્ર 11 જ વર્ષની કુમળી વયે ગૃહત્યાગ કર્યો; માનસ સરોવરથી લઈને નેપાળમાં મુક્તિનાથ-પુલહાશ્રમ સુધી ઉત્તુંગ હિમશિખરોમાં કઠોર તપશ્ચર્યા કરી; પૂર્વના સુંદરવન જેવાં ઘોર જંગલોથી લઈને છેક કન્યાકુમારી સુધી ખુલ્લા પગે એકાકી વિચરણ કર્યું અને ભારતભરના પરિવ્રાજક બનીને છેલ્લે ગુજરાતમાં પ્રવેશ કર્યો.

'કેમ્બ્રિજ હિસ્ટરી આૅફ ગુજરાત'માં ઇતિહાસવિદ્‌ એચ. એચ. ડોડવેલ વર્ણવે છે : 'બધાં જ સ્તર પર વ્યાપેલો આવો સખત ત્રાસ ભારતમાં પૂર્વે ક્યારેય ન હતો. દેશી રાજ્યો અવ્યવસ્થિત હતાં. સમાજ વિસર્જનના આરે આવીને ઊભો હતો. લોકો આપખુદ સત્તાધીશોથી કચડાઈ ગયા હતા અને વધારે પડતા મનસ્વી વેરાથી પાયમાલ થઈ ગયા હતા.'`;

const DEFAULT_STYLE = `AKSHARPITH HOUSE STYLE GUIDE

LANGUAGE & SPELLING
- British English (Oxford/Hart's Rules): colour, honour, travelling, recognised, organised
- Spell out one through ten; numerals for 11 and above
- Dates: 3 April 1781 (no ordinals, no comma after month)

PUNCTUATION
- Curly/smart double quotation marks (" ") for all speech and quotation
- Spaced en dash ( – ) for parenthetical clauses; not em dash
- Oxford comma in series of three or more

TONE & REGISTER
- Reverent and scholarly throughout — this is sacred biography
- Fidelity to source meaning over literary fluency
- Preserve the elevated, devotional register of the original Gujarati

DIACRITICS — RESTRICTIVE POLICY
- Diacritical marks (ā, ī, ū, ṭ, ṇ, etc.) ONLY in canonical verse quotations
- In all running prose: NO diacritics
  e.g. Swaminarayan (not Svāminārāyaṇa), Sahajanand (not Sahajānanda)

MANDATORY GLOSSARY TERMS
- Bhagwan Swaminarayan — full form on first mention per chapter
- Shriji Maharaj — two words, capital M (not Shreeji)
- paramhansa — one word, lower case (not paramahamsa)
- avatari Purush — capital P, no diacritics
- bawa — lower case, no diacritics (not bāwā)
- Swami — capital S (specific BAPS honorific, not generic "saint")
- adharma / dharma / satsang / tapasya — keep Sanskrit, no italics
- Sarvaria Brahmin (not Sarvariya)
- Chhapaiya (not Chhapia / Chhapiya)

QUOTATIONS
- Block-quote any passage over 40 words (indent, no quotation marks)
- Attribute source in running text on first mention: Name, Work Title
- Preserve original verse structure; do not paraphrase`;

const INITIAL_STAGES: StageState[] = [
  { id: 'chunker',    label: 'Chunker',    tagline: 'Splits at paragraph boundaries ≤500 words', status: 'waiting', detail: '' },
  { id: 'translator', label: 'Translator', tagline: 'Translates with full style context',          status: 'waiting', detail: '' },
  { id: 'reviewer',   label: 'Reviewer',   tagline: 'Checks against style rules & scores',         status: 'waiting', detail: '' },
  { id: 'assembler',  label: 'Assembler',  tagline: 'Stitches into coherent document',             status: 'waiting', detail: '' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 85) return '#6B9E74';
  if (score >= 70) return '#E8A84A';
  return '#E05050';
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StageCard({ stage, index }: { stage: StageState; index: number }) {
  const isRunning = stage.status === 'running';
  const isDone    = stage.status === 'done';
  const isError   = stage.status === 'error';

  const borderColor = isRunning ? '#D4922A'
    : isDone  ? '#2A4A2E'
    : isError ? '#5A1E1E'
    : '#2A1E14';

  return (
    <div
      className={isRunning ? 'shimmer-border' : ''}
      style={{
        background: '#1C1510',
        border: `1px solid ${borderColor}`,
        padding: '16px 20px',
        transition: 'border-color 0.4s, box-shadow 0.4s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        {/* Icon */}
        <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {stage.status === 'waiting' && (
            <span style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 18, color: '#3A2C1E', fontWeight: 300 }}>
              {String(index + 1).padStart(2, '0')}
            </span>
          )}
          {isRunning && (
            <div className="spin" style={{
              width: 18, height: 18,
              border: '2px solid #3A2C1E',
              borderTop: '2px solid #D4922A',
              borderRadius: '50%',
            }} />
          )}
          {isDone && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6B9E74" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          {isError && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#E05050" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          )}
        </div>

        {/* Text */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 19, color: '#F2E8D4', fontWeight: 400 }}>
              {stage.label}
            </span>
            {isDone && (
              <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#6B9E74', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
                done
              </span>
            )}
            {isRunning && (
              <span className="pulse-dot" style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#D4922A', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
                running
              </span>
            )}
          </div>
          <p style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: '#8A7A66', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {stage.detail || stage.tagline}
          </p>
        </div>
      </div>
    </div>
  );
}

function ChunkCard({ chunk, isExpanded, onToggle }: {
  chunk: ChunkData;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const hasScore = chunk.score !== undefined;
  const displayText = chunk.revised || chunk.translation;

  return (
    <div style={{ border: '1px solid #2A1E14', background: '#1C1510', overflow: 'hidden' }}
      className="fade-in-up">
      {/* Header row */}
      <button
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px', textAlign: 'left', background: 'transparent', border: 'none',
          cursor: 'pointer', gap: 12,
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = '#221A10')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, flex: 1 }}>
          <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: '#3A2C1E', flexShrink: 0 }}>
            {String(chunk.index + 1).padStart(2, '0')}
          </span>
          <span style={{ fontFamily: '"Lora", serif', fontSize: 13, color: '#9B8878', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {chunk.original.slice(0, 90)}{chunk.original.length > 90 ? '…' : ''}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          {hasScore && (
            <span style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 18, fontWeight: 500, color: scoreColor(chunk.score!) }}>
              {chunk.score}%
            </span>
          )}
          {chunk.translation && !hasScore && (
            <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#2A4A2E', letterSpacing: '0.15em', textTransform: 'uppercase' }}>
              translated
            </span>
          )}
          {chunk.issues && chunk.issues.length > 0 && (
            <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#8A6020', letterSpacing: '0.1em' }}>
              {chunk.issues.length} flag{chunk.issues.length > 1 ? 's' : ''}
            </span>
          )}
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3A2C1E" strokeWidth="2" strokeLinecap="round"
            style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', flexShrink: 0 }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div style={{ borderTop: '1px solid #2A1E14', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Original */}
          <div>
            <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#8A7A66', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 8 }}>
              Original — Gujarati
            </div>
            <p style={{ fontFamily: '"Lora", serif', fontSize: 13, color: '#9B8878', lineHeight: 1.85 }}>
              {chunk.original}
            </p>
          </div>

          {/* Translation */}
          {displayText && (
            <div>
              <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#8A7A66', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 8 }}>
                {chunk.revised ? 'Revised Translation' : 'Translation'}
              </div>
              <p style={{ fontFamily: '"Lora", serif', fontSize: 14, color: '#F2E8D4', lineHeight: 1.9 }}>
                {displayText}
              </p>
            </div>
          )}

          {/* Issues */}
          {chunk.issues && chunk.issues.length > 0 && (
            <div style={{ background: '#14100A', border: '1px solid #2A1E14', padding: '14px 18px' }}>
              <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#D4922A', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 10 }}>
                Reviewer Flags
              </div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {chunk.issues.map((issue, i) => (
                  <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ color: '#D4922A', flexShrink: 0, fontFamily: '"JetBrains Mono", monospace', fontSize: 12, marginTop: 1 }}>—</span>
                    <span style={{ fontFamily: '"Lora", serif', fontSize: 13, color: '#C8B898', lineHeight: 1.65 }}>{issue}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Home() {
  const [inputText, setInputText]       = useState('');
  const [styleContext, setStyleContext] = useState(DEFAULT_STYLE);
  const [stages, setStages]             = useState<StageState[]>(INITIAL_STAGES);
  const [chunks, setChunks]             = useState<ChunkData[]>([]);
  const [output, setOutput]             = useState('');
  const [isRunning, setIsRunning]       = useState(false);
  const [avgScore, setAvgScore]         = useState<number | null>(null);
  const [expandedChunk, setExpandedChunk] = useState<number | null>(null);
  const [copied, setCopied]             = useState(false);
  const [styleOpen, setStyleOpen]       = useState(false);

  const abortRef   = useRef<AbortController | null>(null);
  const chunkMap   = useRef<Record<number, ChunkData>>({});
  const outputRef  = useRef<HTMLDivElement>(null);

  const updateStage = useCallback((id: string, updates: Partial<StageState>) => {
    setStages(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);

  const handleTranslate = async () => {
    if (!inputText.trim() || isRunning) return;

    setStages(INITIAL_STAGES);
    setChunks([]);
    setOutput('');
    setAvgScore(null);
    setExpandedChunk(null);
    chunkMap.current = {};
    setIsRunning(true);

    abortRef.current = new AbortController();

    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: inputText, styleContext }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('No stream body');

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));

            if (ev.error) throw new Error(ev.error);

            // Chunker
            if (ev.stage === 'chunker') {
              if (ev.status === 'running') {
                updateStage('chunker', { status: 'running' });
              } else if (ev.status === 'done') {
                updateStage('chunker', { status: 'done', detail: `Split into ${ev.count} chunk${ev.count !== 1 ? 's' : ''}` });
                (ev.chunks as string[]).forEach((text: string, i: number) => {
                  chunkMap.current[i] = { index: i, original: text };
                });
                setChunks((ev.chunks as string[]).map((t: string, i: number) => ({ index: i, original: t })));
              }
            }

            // Translator
            if (ev.stage === 'translator') {
              if (ev.status === 'running') {
                updateStage('translator', { status: 'running', detail: 'Starting…' });
              } else if (ev.status === 'progress') {
                updateStage('translator', { status: 'running', detail: `Translating chunk ${ev.current} of ${ev.total}…` });
                if (chunkMap.current[ev.index] !== undefined) {
                  chunkMap.current[ev.index] = { ...chunkMap.current[ev.index], translation: ev.translation };
                  setChunks(Object.values(chunkMap.current).sort((a, b) => a.index - b.index));
                }
              } else if (ev.status === 'done') {
                updateStage('translator', { status: 'done', detail: 'All chunks translated' });
              }
            }

            // Reviewer
            if (ev.stage === 'reviewer') {
              if (ev.status === 'running') {
                updateStage('reviewer', { status: 'running', detail: 'Starting review…' });
              } else if (ev.status === 'progress') {
                updateStage('reviewer', { status: 'running', detail: `Reviewing chunk ${ev.chunk}  ·  score: ${ev.score}%` });
                if (chunkMap.current[ev.index] !== undefined) {
                  chunkMap.current[ev.index] = { ...chunkMap.current[ev.index], score: ev.score, issues: ev.issues, revised: ev.revised };
                  setChunks(Object.values(chunkMap.current).sort((a, b) => a.index - b.index));
                }
              } else if (ev.status === 'done') {
                updateStage('reviewer', { status: 'done', detail: `Avg quality: ${Math.round(ev.avgScore)}%` });
                setAvgScore(ev.avgScore);
              }
            }

            // Assembler
            if (ev.stage === 'assembler') {
              if (ev.status === 'running') {
                updateStage('assembler', { status: 'running', detail: 'Assembling document…' });
              } else if (ev.status === 'done') {
                updateStage('assembler', { status: 'done', detail: 'Document ready' });
                setOutput(ev.output);
                setTimeout(() => outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
              }
            }
          } catch (parseErr) {
            console.error('Stream parse error:', parseErr);
          }
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') {
        console.error(e);
        setStages(prev => prev.map(s => s.status === 'running' ? { ...s, status: 'error', detail: 'Error — check console' } : s));
      }
    } finally {
      setIsRunning(false);
    }
  };

  const handleStop = () => { abortRef.current?.abort(); };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'aksharpith-translation.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const isDone    = stages.every(s => s.status === 'done');
  const wc        = wordCount(inputText);

  return (
    <main style={{ minHeight: '100vh', background: '#0A0806' }}>

      {/* ── Header ── */}
      <header style={{ borderBottom: '1px solid #1C1510', padding: '24px 40px' }}>
        <div style={{ maxWidth: 1320, margin: '0 auto', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 36, fontWeight: 300, color: '#F2E8D4', letterSpacing: '0.06em' }}>
              Aksharpith
            </h1>
            <p style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#D4922A', letterSpacing: '0.28em', textTransform: 'uppercase', marginTop: 2 }}>
              Translation Pipeline
            </p>
          </div>

          {avgScore !== null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 32, fontWeight: 400, color: scoreColor(avgScore), lineHeight: 1 }}>
                {Math.round(avgScore)}%
              </div>
              <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#8A7A66', letterSpacing: '0.18em', textTransform: 'uppercase', marginTop: 4 }}>
                avg quality
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Gold rule */}
      <div style={{ height: 1, background: 'linear-gradient(90deg, transparent, #D4922A 30%, #D4922A 70%, transparent)', opacity: 0.3 }} />

      {/* ── Main ── */}
      <div style={{ maxWidth: 1320, margin: '0 auto', padding: '40px 40px 80px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 32 }}>

          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* Gujarati input */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <label style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#8A7A66', letterSpacing: '0.22em', textTransform: 'uppercase' }}>
                  Gujarati Source Text
                </label>
                <button
                  onClick={() => setInputText(SAMPLE_GUJARATI)}
                  style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#3A2C1E', letterSpacing: '0.15em', textTransform: 'uppercase', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.15s' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#D4922A')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#3A2C1E')}
                >
                  Load sample ↗
                </button>
              </div>
              <textarea
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                placeholder="Paste Gujarati text here…"
                disabled={isRunning}
                style={{ width: '100%', height: 280, padding: '16px 20px', fontSize: 14, lineHeight: 1.9, resize: 'vertical', display: 'block' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#3A2C1E' }}>
                  {wc.toLocaleString()} words
                </span>
                <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#3A2C1E' }}>
                  {inputText.length.toLocaleString()} chars
                </span>
              </div>
            </div>

            {/* Style context (collapsible) */}
            <div>
              <button
                onClick={() => setStyleOpen(o => !o)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                  padding: '0 0 10px', borderBottom: styleOpen ? '1px solid #2A1E14' : 'none',
                }}
              >
                <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#8A7A66', letterSpacing: '0.22em', textTransform: 'uppercase' }}>
                  Style Rules & Glossary
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#3A2C1E', letterSpacing: '0.1em' }}>
                    Aksharpith House Style
                  </span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3A2C1E" strokeWidth="2" strokeLinecap="round"
                    style={{ transform: styleOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
              </button>
              {styleOpen && (
                <textarea
                  value={styleContext}
                  onChange={e => setStyleContext(e.target.value)}
                  disabled={isRunning}
                  style={{ width: '100%', height: 220, padding: '14px 18px', fontSize: 12, lineHeight: 1.75, fontFamily: '"JetBrains Mono", monospace', color: '#C8B898', marginTop: 10, resize: 'vertical', display: 'block' }}
                />
              )}
            </div>

            {/* Run / Stop */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleTranslate}
                disabled={isRunning || !inputText.trim()}
                style={{
                  flex: 1, padding: '16px 24px',
                  fontFamily: '"Cormorant Garamond", serif', fontSize: 18, fontWeight: 500,
                  letterSpacing: '0.18em', textTransform: 'uppercase',
                  background: (isRunning || !inputText.trim()) ? 'transparent' : '#D4922A',
                  color: (isRunning || !inputText.trim()) ? '#D4922A' : '#0A0806',
                  border: '1px solid #D4922A',
                  cursor: (isRunning || !inputText.trim()) ? 'not-allowed' : 'pointer',
                  opacity: !inputText.trim() ? 0.35 : 1,
                  transition: 'all 0.25s',
                }}
              >
                {isRunning ? 'Running Pipeline…' : isDone ? 'Run Again' : 'Run Translation Pipeline'}
              </button>

              {isRunning && (
                <button
                  onClick={handleStop}
                  style={{
                    padding: '16px 20px', background: 'none',
                    border: '1px solid #2A1E14', color: '#8A7A66',
                    fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                    letterSpacing: '0.15em', textTransform: 'uppercase', cursor: 'pointer',
                    transition: 'border-color 0.15s, color 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#8A7A66'; e.currentTarget.style.color = '#F2E8D4'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#2A1E14'; e.currentTarget.style.color = '#8A7A66'; }}
                >
                  Stop
                </button>
              )}
            </div>
          </div>

          {/* Right column — Pipeline */}
          <div>
            <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#8A7A66', letterSpacing: '0.22em', textTransform: 'uppercase', marginBottom: 14 }}>
              Pipeline
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stages.map((stage, i) => (
                <StageCard key={stage.id} stage={stage} index={i} />
              ))}
            </div>

            {/* Legend */}
            <div style={{ marginTop: 28, padding: '14px 16px', background: '#141008', border: '1px solid #1C1510' }}>
              <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 9, color: '#3A2C1E', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 10 }}>
                Model allocation
              </div>
              {[
                ['Chunker',    'claude-sonnet-4-6'],
                ['Translator', 'claude-opus-4-6'],
                ['Reviewer',   'claude-sonnet-4-6'],
                ['Assembler',  'claude-opus-4-6'],
              ].map(([stage, model]) => (
                <div key={stage} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#8A7A66' }}>{stage}</span>
                  <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#3A2C1E' }}>{model}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Chunk Details ── */}
        {chunks.length > 0 && (
          <div style={{ marginTop: 56 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 20 }}>
              <h2 style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 26, fontWeight: 400, color: '#F2E8D4' }}>
                Chunk Detail
              </h2>
              <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: '#8A7A66' }}>
                {chunks.length} chunk{chunks.length !== 1 ? 's' : ''}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {chunks.map((chunk, i) => (
                <ChunkCard
                  key={i}
                  chunk={chunk}
                  isExpanded={expandedChunk === i}
                  onToggle={() => setExpandedChunk(expandedChunk === i ? null : i)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Final Output ── */}
        {output && (
          <div ref={outputRef} style={{ marginTop: 56 }} className="fade-in-up">
            {/* Divider */}
            <div style={{ height: 1, background: 'linear-gradient(90deg, transparent, #D4922A 30%, #D4922A 70%, transparent)', opacity: 0.3, marginBottom: 40 }} />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h2 style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 26, fontWeight: 400, color: '#F2E8D4' }}>
                Final Translation
              </h2>
              <div style={{ display: 'flex', gap: 8 }}>
                {[
                  { label: copied ? 'Copied!' : 'Copy text', onClick: handleCopy },
                  { label: 'Download .txt', onClick: handleDownload },
                ].map(({ label, onClick }) => (
                  <button
                    key={label}
                    onClick={onClick}
                    style={{
                      padding: '9px 18px', background: 'none',
                      border: '1px solid #2A1E14', color: '#8A7A66',
                      fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                      letterSpacing: '0.14em', textTransform: 'uppercase', cursor: 'pointer',
                      transition: 'border-color 0.15s, color 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#D4922A'; e.currentTarget.style.color = '#D4922A'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#2A1E14'; e.currentTarget.style.color = '#8A7A66'; }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ background: '#141008', border: '1px solid #2A1E14', padding: '40px 48px' }}>
              {/* Decorative cap */}
              <div style={{ width: 40, height: 1, background: '#D4922A', opacity: 0.5, marginBottom: 28 }} />
              <div style={{ fontFamily: '"Lora", serif', fontSize: 15, color: '#F2E8D4', lineHeight: 2, whiteSpace: 'pre-wrap' }}>
                {output}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
