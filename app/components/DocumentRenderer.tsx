'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMemo } from 'react';

/**
 * Pre-processes pipeline output text into light markdown for proper rendering.
 * Detects transliterations, attributed quotes, and structural elements.
 */
function preprocessToMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Italicise transliterated text in curly quotes: "xyz" → *"xyz"*
    line = line.replace(/(\u201c[^\u201d]*\u201d)/g, (match) => {
      if (/[āīūṛṅñṭḍṇśṣḥ]/.test(match)) return `*${match}*`;
      return match;
    });

    // Italicise standalone transliteration lines (contain diacritics, short-ish)
    const trimmed = line.trim();
    if (trimmed && /[āīūṛṅñṭḍṇśṣḥ]/.test(trimmed) && !trimmed.startsWith('*') && !trimmed.startsWith('#')) {
      const words = trimmed.split(/\s+/).length;
      // If the line is mostly transliteration (short poetic lines)
      if (words <= 20 && !/^[\d]/.test(trimmed) && !/^[A-Z][a-z]/.test(trimmed)) {
        line = `*${trimmed}*`;
      }
    }

    // Parenthesized meanings → italic
    if (/^\(.*\)$/.test(trimmed) && trimmed.length > 10) {
      line = `*${trimmed}*`;
    }

    result.push(line);
  }

  return result.join('\n');
}

interface Props {
  text: string;
  className?: string;
  compact?: boolean;
}

export default function DocumentRenderer({ text, className, compact }: Props) {
  const markdown = useMemo(() => preprocessToMarkdown(text), [text]);

  const fontSize = compact ? 14 : 17;
  const lineHeight = compact ? 1.7 : 1.9;

  return (
    <div className={className}>
      <style>{`
        .doc-render p {
          font-family: "Cormorant Garamond", serif;
          font-size: ${fontSize}px;
          font-weight: 400;
          line-height: ${lineHeight};
          color: var(--text-body);
          margin: 0 0 ${compact ? '10' : '16'}px 0;
        }
        .doc-render p:last-child { margin-bottom: 0; }
        .doc-render em {
          font-style: italic;
          color: var(--text);
        }
        .doc-render strong {
          font-weight: 600;
          color: var(--text);
        }
        .doc-render blockquote {
          margin: ${compact ? '8' : '16'}px 0;
          padding: ${compact ? '10px 14px' : '14px 20px'};
          border-left: 2px solid var(--border);
          background: var(--bg);
          border-radius: 0 4px 4px 0;
        }
        .doc-render blockquote p {
          font-size: ${compact ? 13 : 15}px;
          color: var(--text-muted);
          margin: 0;
        }
        .doc-render h1, .doc-render h2, .doc-render h3 {
          font-family: "Cormorant Garamond", serif;
          color: var(--text);
          margin: ${compact ? '14' : '24'}px 0 ${compact ? '6' : '10'}px 0;
          line-height: 1.3;
        }
        .doc-render h1 { font-size: ${compact ? 18 : 24}px; font-weight: 600; }
        .doc-render h2 { font-size: ${compact ? 16 : 20}px; font-weight: 500; }
        .doc-render h3 { font-size: ${compact ? 15 : 18}px; font-weight: 500; }
        .doc-render ul, .doc-render ol {
          font-family: "Cormorant Garamond", serif;
          font-size: ${fontSize}px;
          line-height: ${lineHeight};
          color: var(--text-body);
          margin: 0 0 ${compact ? '10' : '16'}px 0;
          padding-left: 24px;
        }
        .doc-render li { margin-bottom: 4px; }
        .doc-render hr {
          border: none;
          height: 1px;
          background: var(--border);
          margin: ${compact ? '12' : '20'}px 0;
        }
        .doc-render a {
          color: var(--text);
          text-decoration: underline;
          text-underline-offset: 2px;
        }
      `}</style>
      <div className="doc-render">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
}
