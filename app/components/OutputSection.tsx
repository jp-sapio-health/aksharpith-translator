'use client';

import type { OutputSection as OutputSectionType } from '../../lib/rules/types';
import VerseBlock from './VerseBlock';

interface Props {
  section: OutputSectionType;
  onCommentClick?: (sectionIndex: number) => void;
  commentCount?: number;
}

export default function OutputSectionView({ section, onCommentClick, commentCount }: Props) {
  if (section.type === 'verse') {
    return (
      <div style={{ position: 'relative' }}>
        <VerseBlock section={section} />
        {onCommentClick && (
          <button
            onClick={() => onCommentClick(section.index)}
            style={{
              position: 'absolute', top: 8, right: 8,
              fontSize: 11, fontWeight: 500, color: 'var(--text-light)',
              background: 'var(--bg-white)', border: '1px solid var(--border)',
              borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
              opacity: 0.7, transition: 'opacity 0.2s',
            }}
            onMouseEnter={e => { (e.target as HTMLElement).style.opacity = '1'; }}
            onMouseLeave={e => { (e.target as HTMLElement).style.opacity = '0.7'; }}
          >
            {commentCount ? `${commentCount} comment${commentCount !== 1 ? 's' : ''}` : '+ Comment'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', padding: '4px 0' }}>
      <div style={{
        fontFamily: '"Cormorant Garamond", serif',
        fontSize: 17,
        fontWeight: 400,
        lineHeight: 1.9,
        color: 'var(--text-body)',
      }}>
        {section.content}
      </div>
      {onCommentClick && (
        <button
          onClick={() => onCommentClick(section.index)}
          style={{
            position: 'absolute', top: 4, right: 0,
            fontSize: 11, fontWeight: 500, color: 'var(--text-light)',
            background: 'var(--bg-white)', border: '1px solid var(--border)',
            borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
            opacity: 0, transition: 'opacity 0.2s',
          }}
          onMouseEnter={e => { (e.target as HTMLElement).style.opacity = '1'; }}
          onMouseLeave={e => { (e.target as HTMLElement).style.opacity = '0.7'; }}
          className="section-comment-btn"
        >
          {commentCount ? `${commentCount} comment${commentCount !== 1 ? 's' : ''}` : '+ Comment'}
        </button>
      )}
    </div>
  );
}
