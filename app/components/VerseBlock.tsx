'use client';

import type { OutputSection } from '../../lib/rules/types';

export default function VerseBlock({ section }: { section: OutputSection }) {
  const lines = section.content.split('\n').map(l => l.trim()).filter(Boolean);

  return (
    <div style={{
      padding: '20px 24px',
      margin: '8px 0',
      background: 'var(--bg-warm)',
      borderLeft: '3px solid var(--amber)',
      borderRadius: '0 var(--radius) var(--radius) 0',
    }}>
      {lines.map((line, i) => {
        // Detect transliteration lines (contain diacritics or curly quotes)
        const isTranslit = /[āīūṛṅñṭḍṇśṣḥ]/.test(line) || /^[\u201c\u201d]/.test(line);
        // Detect meaning lines (parenthesized)
        const isMeaning = /^\(.*\)$/.test(line);

        if (isTranslit) {
          return (
            <div key={i} style={{
              fontFamily: '"Cormorant Garamond", serif',
              fontSize: 17,
              fontStyle: 'italic',
              color: 'var(--text)',
              lineHeight: 1.9,
              letterSpacing: '0.2px',
            }}>
              {line}
            </div>
          );
        }

        if (isMeaning) {
          return (
            <div key={i} style={{
              fontFamily: '"Cormorant Garamond", serif',
              fontSize: 15,
              color: 'var(--text-muted)',
              lineHeight: 1.7,
              marginTop: 4,
            }}>
              {line}
            </div>
          );
        }

        return (
          <div key={i} style={{
            fontFamily: '"Cormorant Garamond", serif',
            fontSize: 16,
            color: 'var(--text-body)',
            lineHeight: 1.8,
          }}>
            {line}
          </div>
        );
      })}
    </div>
  );
}
