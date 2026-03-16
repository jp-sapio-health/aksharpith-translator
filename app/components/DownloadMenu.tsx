'use client';

import { useState, useRef, useEffect } from 'react';

interface Props {
  output: string;
  translationId: string | null;
  filename: string;
  getToken: () => Promise<string | null>;
}

type Format = 'txt' | 'docx' | 'docx-reviews' | 'training-json';

export default function DownloadMenu({ output, translationId, filename, getToken }: Props) {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState<Format | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const baseName = filename ? filename.replace(/\.[^.]+$/, '') : 'translation';

  const downloadTxt = () => {
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `${baseName}-en.txt` });
    a.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  };

  const downloadFromApi = async (format: 'docx' | 'docx-reviews' | 'training-json') => {
    if (!translationId) {
      // Fallback: if no translationId, download plain text
      downloadTxt();
      return;
    }
    setDownloading(format);
    try {
      const token = await getToken();
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ translationId, format, output }),
      });
      if (!res.ok) {
        console.error('Export failed:', res.status);
        setDownloading(null);
        return;
      }

      if (format === 'training-json') {
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: `${baseName}-training.json` });
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const ext = format === 'docx-reviews' ? '-with-reviews.docx' : '.docx';
        const a = Object.assign(document.createElement('a'), { href: url, download: `${baseName}-en${ext}` });
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Export error:', err);
    }
    setDownloading(null);
    setOpen(false);
  };

  const formats: Array<{ id: Format; label: string; desc: string }> = [
    { id: 'txt', label: 'Plain Text (.txt)', desc: 'Translation only' },
    { id: 'docx', label: 'Word Document (.docx)', desc: 'Formatted with verse styling' },
    { id: 'docx-reviews', label: 'Word + Reviews (.docx)', desc: 'Includes reviewer comments' },
    { id: 'training-json', label: 'Training Data (.json)', desc: 'Source + translation + scores + comments' },
  ];

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(prev => !prev)}
        style={{
          padding: '14px 20px', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', background: 'var(--bg-white)',
          color: 'var(--text-muted)', fontFamily: "'Karla', sans-serif",
          fontSize: 11, fontWeight: 600, letterSpacing: '1.5px',
          textTransform: 'uppercase', cursor: 'pointer', transition: 'all 0.2s',
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        Download {open ? '\u25B2' : '\u25BC'}
      </button>

      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 6,
          background: 'var(--bg-white)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
          minWidth: 260, zIndex: 50, overflow: 'hidden',
        }} className="fadein">
          {formats.map(fmt => (
            <button
              key={fmt.id}
              onClick={() => fmt.id === 'txt' ? downloadTxt() : downloadFromApi(fmt.id)}
              disabled={downloading !== null}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '12px 16px', border: 'none', background: 'transparent',
                cursor: downloading ? 'wait' : 'pointer',
                borderBottom: '1px solid var(--border-light)',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { (e.target as HTMLElement).style.background = 'var(--bg)'; }}
              onMouseLeave={e => { (e.target as HTMLElement).style.background = 'transparent'; }}
            >
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
                {downloading === fmt.id ? 'Generating\u2026' : fmt.label}
              </div>
              <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--text-light)', marginTop: 2 }}>
                {fmt.desc}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
