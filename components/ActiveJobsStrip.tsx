'use client';

// Small horizontal strip showing the user's in-flight transliteration
// jobs, with a one-click jump to the live viewer. Read-only — listens
// to Firestore via onSnapshot so it stays current without polling and
// disappears entirely once nothing's running.
//
// Designed to slot above the main translator UI on /, never interferes
// with the upload / paste / pipeline flow.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../lib/auth-context';
import { getFirebaseDb } from '../lib/firebase';
import { cn } from '../lib/utils';

type Row = {
  id: string;
  filename: string;
  status: string;
  pagesCompleted: number;
  totalPages: number;
};

const ACTIVE_STATUSES = new Set([
  'pending',
  'ocr_running',
  'assembling',
  'transliterating',
]);

export function ActiveJobsStrip() {
  const { user } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!user) {
      setRows([]);
      return;
    }
    const db = getFirebaseDb();
    // Single-field where to avoid composite index. Status filtering lives
    // client-side so we can include all four active statuses.
    const q = query(collection(db, 'transliterationJobs'), where('uid', '==', user.uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next: Row[] = [];
        snap.forEach((d) => {
          const data = d.data();
          if (!ACTIVE_STATUSES.has(data.status)) return;
          next.push({
            id: d.id,
            filename: data.filename ?? '(untitled)',
            status: data.status,
            pagesCompleted: data.pagesCompleted ?? 0,
            totalPages: data.totalPages ?? 0,
          });
        });
        // Newest in-flight first.
        next.sort((a, b) => b.id.localeCompare(a.id));
        setRows(next.slice(0, 4));
      },
      (err) => console.error('[active-jobs-strip] subscribe error', err),
    );
    return unsub;
  }, [user]);

  if (rows.length === 0) return null;

  return (
    <div className="border-b border-stone-200 bg-white/60 backdrop-blur-sm">
      <div className="mx-auto max-w-3xl px-5 py-2 flex items-center gap-3 overflow-x-auto">
        <span className="text-[10px] font-mono uppercase tracking-wider text-stone-500 shrink-0">
          Active
        </span>
        {rows.map((r) => {
          const pct = r.totalPages > 0 ? Math.round((r.pagesCompleted / r.totalPages) * 100) : 0;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => router.push(`/transliterate/${r.id}`)}
              className="group shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-full border border-stone-200 bg-white hover:border-amber-400 transition-colors"
            >
              <span
                className={cn(
                  'inline-flex h-1.5 w-1.5 rounded-full',
                  r.status === 'pending' ? 'bg-stone-400' : 'bg-amber-500 animate-pulse',
                )}
              />
              <span className="text-xs text-stone-700 max-w-[16ch] truncate">
                {r.filename}
              </span>
              <span className="text-[10px] font-mono tabular-nums text-stone-400">
                {pct}%
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
