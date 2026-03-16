'use client';

import { useState, useEffect, useRef } from 'react';
import type { ReviewComment } from '../../lib/rules/types';

interface Props {
  translationId: string | null;
  sectionIndex: number;
  open: boolean;
  onClose: () => void;
  user: { uid: string; email: string | null; displayName: string | null } | null;
  getToken: () => Promise<string | null>;
}

export default function ReviewPanel({ translationId, sectionIndex, open, onClose, user, getToken }: Props) {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Fetch comments when panel opens
  useEffect(() => {
    if (!open || !translationId) return;
    setLoading(true);
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch(`/api/reviews/${translationId}?sectionIndex=${sectionIndex}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const data = await res.json();
          setComments(data.comments ?? []);
        }
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [open, translationId, sectionIndex, getToken]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const handleSubmit = async () => {
    if (!newComment.trim() || !translationId || !user || submitting) return;
    setSubmitting(true);
    try {
      const token = await getToken();
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          translationId,
          sectionIndex,
          comment: newComment.trim(),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setComments(prev => [...prev, data.comment]);
        setNewComment('');
      }
    } catch { /* ignore */ }
    setSubmitting(false);
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.15)',
          zIndex: 200, transition: 'opacity 0.2s',
        }}
      />

      {/* Panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 380, maxWidth: '90vw', background: 'var(--bg-white)',
        borderLeft: '1px solid var(--border)', zIndex: 201,
        display: 'flex', flexDirection: 'column',
        boxShadow: '-4px 0 20px rgba(0,0,0,0.06)',
      }} className="fadein">
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <div>
            <div style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: 20, fontWeight: 400, color: 'var(--text)' }}>
              Comments
            </div>
            <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--text-light)', marginTop: 2 }}>
              Section {sectionIndex + 1}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              fontSize: 18, color: 'var(--text-light)', background: 'none',
              border: 'none', cursor: 'pointer', padding: '4px 8px', lineHeight: 1,
            }}
          >
            \u2715
          </button>
        </div>

        {/* Comments list */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: '16px 20px',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          {loading && (
            <div style={{ fontSize: 13, color: 'var(--text-light)', fontStyle: 'italic' }}>Loading comments\u2026</div>
          )}
          {!loading && comments.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-light)', fontStyle: 'italic' }}>No comments yet on this section.</div>
          )}
          {comments.map((c, i) => (
            <div key={c.id ?? i} style={{
              background: 'var(--bg)', border: '1px solid var(--border-light)',
              borderRadius: 6, padding: '12px 14px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                  {c.displayName || c.email || 'Anonymous'}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-light)' }}>
                  {new Date(c.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--text-body)', lineHeight: 1.65 }}>
                {c.comment}
              </div>
            </div>
          ))}
        </div>

        {/* New comment form */}
        <div style={{ borderTop: '1px solid var(--border)', padding: '14px 20px' }}>
          <textarea
            ref={inputRef}
            value={newComment}
            onChange={e => setNewComment(e.target.value)}
            placeholder="Add a review comment\u2026"
            style={{
              width: '100%', minHeight: 60, padding: 10, fontSize: 13,
              fontWeight: 300, color: 'var(--text)', background: 'var(--bg)',
              border: '1px solid var(--border)', borderRadius: 6,
              outline: 'none', resize: 'vertical', lineHeight: 1.6,
            }}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--text-light)' }}>
              {user?.displayName || user?.email || ''}
            </span>
            <button
              onClick={handleSubmit}
              disabled={!newComment.trim() || submitting}
              style={{
                fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase',
                padding: '8px 16px', borderRadius: 6, cursor: 'pointer',
                border: '1px solid var(--text)', background: 'var(--text)', color: 'var(--bg-white)',
                opacity: !newComment.trim() || submitting ? 0.4 : 1,
                fontFamily: "'Karla', sans-serif", transition: 'opacity 0.2s',
              }}
            >
              {submitting ? 'Posting\u2026' : 'Post'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
