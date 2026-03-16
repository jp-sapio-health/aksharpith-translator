'use client';

import { useMemo } from 'react';
import type { OutputSection } from '../../lib/rules/types';
import type { ReviewComment } from '../../lib/rules/types';
import { parseOutputSections } from '../../lib/parse-output';
import OutputSectionView from './OutputSection';

interface Props {
  output: string;
  onCommentClick?: (sectionIndex: number) => void;
  commentCounts?: Record<number, number>;
}

export default function OutputView({ output, onCommentClick, commentCounts }: Props) {
  const sections: OutputSection[] = useMemo(() => parseOutputSections(output), [output]);

  if (sections.length === 0) return null;

  return (
    <div style={{
      background: 'var(--bg-white)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: 24,
    }} className="fadein">
      <style>{`
        .section-comment-btn { opacity: 0 !important; }
        .output-section-wrap:hover .section-comment-btn { opacity: 0.7 !important; }
      `}</style>
      {sections.map(section => (
        <div key={section.index} className="output-section-wrap">
          <OutputSectionView
            section={section}
            onCommentClick={onCommentClick}
            commentCount={commentCounts?.[section.index]}
          />
        </div>
      ))}
    </div>
  );
}
