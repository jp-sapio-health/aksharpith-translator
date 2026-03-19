'use client';

import type { OutputSection } from '../../lib/rules/types';

export default function VerseBlock({ section }: { section: OutputSection }) {
  const lines = section.content.split('\n').map(l => l.trim()).filter(Boolean);

  return (
    <div style={{ margin: '4px 0' }}>
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
              fontStyle: 'italic',
              color: 'var(--text-muted)',
              lineHeight: 1.7,
              marginTop: 2,
            }}>
              {line}
            </div>
          );
        }

        return (
          <div key={i} style={{
            fontFamily: '"Cormorant Garamond", serif',
            fontSize: 17,
            color: 'var(--text-body)',
            lineHeight: 1.9,
          }}>
            {line}
          </div>
        );
      })}
    </div>
  );
}
