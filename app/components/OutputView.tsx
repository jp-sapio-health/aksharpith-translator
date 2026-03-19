'use client';

import { useMemo, useState, useCallback } from 'react';
import { parseOutputSections } from '../../lib/parse-output';
import DocumentRenderer from './DocumentRenderer';

interface Props {
  output: string;
  onCommentClick?: (sectionIndex: number) => void;
  commentCounts?: Record<number, number>;
}

export default function OutputView({ output, onCommentClick, commentCounts }: Props) {
  const sections = useMemo(() => parseOutputSections(output), [output]);
  const [hoveredSection, setHoveredSection] = useState<number | null>(null);

  const handleSectionHover = useCallback((index: number | null) => {
    setHoveredSection(index);
  }, []);

  if (!output?.trim()) return null;

  // If no comment system, just render the full document cleanly
  if (!onCommentClick) {
    return <DocumentRenderer text={output} />;
  }

  // Render section-by-section with comment affordances
  return (
    <div>
      <style>{`
        .doc-section { position: relative; border-radius: 4px; transition: background 0.15s; }
        .doc-section:hover { background: rgba(0,0,0,0.015); }
        .doc-section .comment-marker { opacity: 0; transition: opacity 0.15s; }
        .doc-section:hover .comment-marker { opacity: 1; }
      `}</style>
      {sections.map(section => {
        const count = commentCounts?.[section.index];
        const hasComments = count && count > 0;
        return (
          <div
            key={section.index}
            className="doc-section"
            style={{ padding: '2px 8px', margin: '0 -8px' }}
            onMouseEnter={() => handleSectionHover(section.index)}
            onMouseLeave={() => handleSectionHover(null)}
          >
            <DocumentRenderer text={section.content} />

            {/* Comment indicator */}
            {(hoveredSection === section.index || hasComments) && (
              <button
                onClick={() => onCommentClick(section.index)}
                className={hasComments ? '' : 'comment-marker'}
                style={{
                  position: 'absolute', top: 6, right: -4,
                  display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 11, fontWeight: 500,
                  color: hasComments ? 'var(--amber)' : 'var(--text-light)',
                  background: 'var(--bg-white)',
                  border: `1px solid ${hasComments ? 'var(--amber-border)' : 'var(--border)'}`,
                  borderRadius: 4, padding: '3px 10px',
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                {hasComments ? (
                  <>{count} comment{count !== 1 ? 's' : ''}</>
                ) : (
                  <>+ Comment</>
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
