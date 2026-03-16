'use client';

import { useState } from 'react';

interface Correction {
  from: string;
  to: string;
  rule?: string;
  count: number;
}

interface ReviewerSummary {
  avgScore: number;
  certifiedCount: number;
  totalChunks: number;
  categories: Array<{ id: string; weight: number; avgScore: number }>;
  totalDeductions: number;
  topIssues: string[];
}

interface Props {
  corrections: Correction[];
  reviewerSummary: ReviewerSummary | null;
  totalFixes: number;
}

type CorrectionCategory = 'Terminology' | 'Historical Names' | 'Place Names' | 'Forbidden Vocab' | 'Hedging' | 'Punctuation' | 'Diacritics' | 'Date Format' | 'Other';

function categoriseCorrection(c: Correction): CorrectionCategory {
  const rule = (c.rule ?? '').toLowerCase();
  if (rule.includes('forbidden')) return 'Forbidden Vocab';
  if (rule.includes('hedging')) return 'Hedging';
  if (rule.includes('diacritics') || rule.includes('diacritical')) return 'Diacritics';
  if (rule.includes('quotes') || rule.includes('dash')) return 'Punctuation';
  if (rule.includes('date')) return 'Date Format';
  if (rule.includes('province') || rule.includes('pipalana') || rule.includes('chanasad') || rule.includes('bamangaon') || rule.includes('dholiya') || rule.includes('dungara') || rule.includes('bhadarod') || rule.includes('chokshi') || rule.includes('saurashtra')) return 'Place Names';
  if (rule.includes('bhilalbhai') || rule.includes('narayanda') || rule.includes('naranda')) return 'Historical Names';
  return 'Terminology';
}

const CATEGORY_COLORS: Record<CorrectionCategory, { bg: string; color: string; border: string }> = {
  'Terminology':     { bg: 'var(--green-bg)',  color: 'var(--green)',  border: 'var(--green-border)' },
  'Historical Names': { bg: 'var(--amber-bg)',  color: 'var(--amber)',  border: 'var(--amber-border)' },
  'Place Names':     { bg: 'var(--amber-bg)',  color: 'var(--amber)',  border: 'var(--amber-border)' },
  'Forbidden Vocab': { bg: 'var(--red-bg)',    color: 'var(--red)',    border: 'var(--red-border)' },
  'Hedging':         { bg: 'var(--red-bg)',    color: 'var(--red)',    border: 'var(--red-border)' },
  'Punctuation':     { bg: 'var(--bg-warm)',   color: 'var(--text-muted)', border: 'var(--border)' },
  'Diacritics':      { bg: 'var(--bg-warm)',   color: 'var(--text-muted)', border: 'var(--border)' },
  'Date Format':     { bg: 'var(--amber-bg)',  color: 'var(--amber)',  border: 'var(--amber-border)' },
  'Other':           { bg: 'var(--bg-warm)',   color: 'var(--text-muted)', border: 'var(--border)' },
};

const CATEGORY_ORDER: CorrectionCategory[] = [
  'Terminology', 'Forbidden Vocab', 'Hedging', 'Historical Names', 'Place Names', 'Date Format', 'Punctuation', 'Diacritics', 'Other',
];

const REVIEWER_LABELS: Record<string, string> = {
  FIDELITY: 'Fidelity',
  TERMINOLOGY: 'Terminology',
  VERSE_HANDLING: 'Verse Handling',
  STYLE_REGISTER: 'Style & Register',
  HISTORICAL_PRECISION: 'Historical Precision',
  COMPLETENESS: 'Completeness',
};

export default function QualitySummary({ corrections, reviewerSummary, totalFixes }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Group corrections by category
  const grouped = new Map<CorrectionCategory, Correction[]>();
  for (const c of corrections) {
    const cat = categoriseCorrection(c);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(c);
  }

  const sortedCategories = CATEGORY_ORDER.filter(cat => grouped.has(cat));
  const hasReviewer = reviewerSummary && reviewerSummary.categories.length > 0;

  if (totalFixes === 0 && !hasReviewer) return null;

  return (
    <div style={{
      background: 'var(--bg-white)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', overflow: 'hidden',
    }} className="fadein">

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '18px 22px', borderBottom: '1px solid var(--border-light)',
      }}>
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 2,
            textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 4,
          }}>
            Quality Assurance
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {totalFixes > 0 && (
              <span style={{
                fontFamily: "'Karla', sans-serif", fontSize: 13, fontWeight: 600,
                color: 'var(--green)',
              }}>
                {totalFixes} deterministic fix{totalFixes !== 1 ? 'es' : ''}
              </span>
            )}
            {hasReviewer && (
              <span style={{
                fontFamily: "'Karla', sans-serif", fontSize: 13, fontWeight: 600,
                color: reviewerSummary!.avgScore >= 90 ? 'var(--green)' : reviewerSummary!.avgScore >= 80 ? 'var(--amber)' : 'var(--red)',
              }}>
                {reviewerSummary!.avgScore}% reviewer score
              </span>
            )}
            {hasReviewer && (
              <span style={{ fontSize: 11, color: 'var(--text-light)' }}>
                {reviewerSummary!.certifiedCount}/{reviewerSummary!.totalChunks} certified
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => setExpanded(prev => !prev)}
          style={{
            fontSize: 11, fontWeight: 500, color: 'var(--text-light)',
            background: 'none', border: '1px solid var(--border)',
            borderRadius: 4, padding: '5px 12px', cursor: 'pointer',
            fontFamily: "'Karla', sans-serif",
          }}
        >
          {expanded ? 'Collapse' : 'Details'}
        </button>
      </div>

      {/* Compact category pills — always visible */}
      <div style={{ padding: '14px 22px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {sortedCategories.map(cat => {
          const items = grouped.get(cat)!;
          const count = items.reduce((s, c) => s + c.count, 0);
          const colors = CATEGORY_COLORS[cat];
          return (
            <div key={cat} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 4,
              background: colors.bg, border: `1px solid ${colors.border}`,
            }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: colors.color }}>{count}</span>
              <span style={{ fontSize: 11, fontWeight: 400, color: colors.color }}>{cat}</span>
            </div>
          );
        })}
        {hasReviewer && reviewerSummary!.totalDeductions > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 4,
            background: 'var(--amber-bg)', border: '1px solid var(--amber-border)',
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--amber)' }}>{reviewerSummary!.totalDeductions}</span>
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--amber)' }}>Reviewer Deductions</span>
          </div>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '0 22px 20px' }}>

          {/* Enforcer corrections by category */}
          {sortedCategories.length > 0 && (
            <div style={{ marginBottom: hasReviewer ? 20 : 0 }}>
              <div style={{
                fontSize: 10, fontWeight: 600, letterSpacing: 2,
                textTransform: 'uppercase', color: 'var(--text-light)',
                marginBottom: 10, paddingTop: 4,
              }}>
                Deterministic Enforcement
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                {sortedCategories.map(cat => {
                  const items = grouped.get(cat)!;
                  const colors = CATEGORY_COLORS[cat];
                  return (
                    <div key={cat} style={{
                      background: 'var(--bg)', borderRadius: 6,
                      border: '1px solid var(--border-light)', padding: '12px 14px',
                    }}>
                      <div style={{
                        fontSize: 11, fontWeight: 600, color: colors.color,
                        marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8,
                      }}>
                        {cat}
                      </div>
                      {items.map((c, i) => (
                        <div key={i} style={{ fontSize: 12, fontWeight: 300, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                          <span style={{ color: 'var(--red)', textDecoration: 'line-through' }}>{c.from}</span>
                          {' \u2192 '}
                          <span style={{ color: 'var(--green)', fontWeight: 500 }}>{c.to || '\u2715'}</span>
                          <span style={{ color: 'var(--text-light)', fontSize: 10, marginLeft: 4 }}>
                            ({c.count})
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Reviewer findings */}
          {hasReviewer && (
            <div>
              <div style={{
                fontSize: 10, fontWeight: 600, letterSpacing: 2,
                textTransform: 'uppercase', color: 'var(--text-light)',
                marginBottom: 10,
              }}>
                AI Reviewer Findings
              </div>

              {/* Category score bars */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {reviewerSummary!.categories.map(cat => {
                  const pct = cat.weight > 0 ? (cat.avgScore / cat.weight) * 100 : 0;
                  const color = pct >= 90 ? 'var(--green)' : pct >= 75 ? 'var(--amber)' : 'var(--red)';
                  return (
                    <div key={cat.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', width: 130, flexShrink: 0 }}>
                        {REVIEWER_LABELS[cat.id] ?? cat.id}
                      </span>
                      <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3 }}>
                        <div style={{
                          height: '100%', borderRadius: 3, width: `${pct}%`,
                          background: color, transition: 'width 0.5s',
                        }} />
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, color, width: 50, textAlign: 'right' }}>
                        {cat.avgScore}/{cat.weight}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Top issues from reviewer */}
              {reviewerSummary!.topIssues.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6 }}>
                    Issues found & corrected by reviewer:
                  </div>
                  <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {reviewerSummary!.topIssues.map((issue, i) => (
                      <li key={i} style={{ fontSize: 12, fontWeight: 300, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                        {issue}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
