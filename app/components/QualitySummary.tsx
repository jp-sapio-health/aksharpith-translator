'use client';

import { useState } from 'react';

interface Correction {
  from: string;
  to: string;
  rule?: string;
  count: number;
}

interface Props {
  corrections: Correction[];
  totalFixes: number;
}

type CorrectionCategory =
  | 'Terminology' | 'Historical Names' | 'Place Names' | 'Forbidden Vocab'
  | 'Hedging' | 'Punctuation' | 'Diacritics' | 'Date Format' | 'Other';

function categoriseCorrection(c: Correction): CorrectionCategory {
  const rule = (c.rule ?? '').toLowerCase();
  if (rule.includes('forbidden')) return 'Forbidden Vocab';
  if (rule.includes('hedging')) return 'Hedging';
  if (rule.includes('diacritics') || rule.includes('diacritical')) return 'Diacritics';
  if (rule.includes('quotes') || rule.includes('dash')) return 'Punctuation';
  if (rule.includes('date')) return 'Date Format';
  if (
    rule.includes('province') || rule.includes('pipalana') || rule.includes('chanasad') ||
    rule.includes('bamangaon') || rule.includes('dholiya') || rule.includes('dungara') ||
    rule.includes('bhadarod') || rule.includes('chokshi') || rule.includes('saurashtra')
  ) return 'Place Names';
  if (rule.includes('bhilalbhai') || rule.includes('narayanda') || rule.includes('naranda')) return 'Historical Names';
  return 'Terminology';
}

const CATEGORY_ORDER: CorrectionCategory[] = [
  'Terminology', 'Forbidden Vocab', 'Hedging', 'Historical Names',
  'Place Names', 'Date Format', 'Punctuation', 'Diacritics', 'Other',
];

/**
 * Quality summary for the user-facing output view. PR 4: shows ONLY
 * deterministic enforcer corrections (rule fires applied to the text).
 * Reviewer-derived metrics (score, certified count, deductions) are
 * admin-only and live in /admin — they are not displayed here.
 */
export default function QualitySummary({ corrections, totalFixes }: Props) {
  const [expanded, setExpanded] = useState(false);

  const grouped = new Map<CorrectionCategory, Correction[]>();
  for (const c of corrections) {
    const cat = categoriseCorrection(c);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(c);
  }

  const sortedCategories = CATEGORY_ORDER.filter(cat => grouped.has(cat));

  if (totalFixes === 0) return null;

  return (
    <div className="rounded-md border bg-paper overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5 border-b">
        <div className="min-w-0">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
            Quality Assurance
          </div>
          <div className="text-sm font-medium text-foreground tabular-nums">
            {totalFixes} deterministic fix{totalFixes !== 1 ? 'es' : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          className="min-h-[44px] sm:min-h-0 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border bg-background hover:bg-paper-warm transition-colors text-muted-foreground"
        >
          {expanded ? 'Collapse' : 'Details'}
        </button>
      </div>

      {/* Compact category pills */}
      <div className="flex flex-wrap gap-1.5 px-4 py-3 sm:px-5">
        {sortedCategories.map(cat => {
          const items = grouped.get(cat)!;
          const count = items.reduce((s, c) => s + c.count, 0);
          return (
            <div
              key={cat}
              className="flex items-center gap-1.5 rounded border border-border/70 bg-background px-2.5 py-1 text-xs"
            >
              <span className="font-medium text-foreground tabular-nums">{count}</span>
              <span className="text-muted-foreground">{cat}</span>
            </div>
          );
        })}
      </div>

      {/* Expanded detail */}
      {expanded && sortedCategories.length > 0 && (
        <div className="px-4 pb-4 sm:px-5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2 pt-1">
            Deterministic Enforcement
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {sortedCategories.map(cat => {
              const items = grouped.get(cat)!;
              return (
                <div key={cat} className="rounded-md border border-border/60 bg-background px-3 py-2.5">
                  <div className="text-[11px] font-mono uppercase tracking-wider text-foreground/80 mb-1.5">
                    {cat}
                  </div>
                  <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                    {items.map((c, i) => (
                      <li key={i}>
                        <span className="line-through text-destructive/80">{c.from}</span>
                        {' → '}
                        <span className="font-medium text-foreground">{c.to || '✕'}</span>
                        <span className="ml-1 text-muted-foreground/70 tabular-nums">({c.count})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
