// Shared types for the polling-based pipeline job system

export interface PipelineInput {
  text: string;
  wordCount: number;
  chapterTitle?: string;
  bookId?: string;
  bookTitle?: string;
  chapterIndex?: number;
  totalChapters?: number;
}

export interface PipelineAuth {
  uid: string;
  email: string;
}

export interface StageProgress {
  status: 'waiting' | 'running' | 'done';
  completed?: number;
  total?: number;
  chunkCount?: number;
  totalFixes?: number;
}

export interface ChunkProgress {
  index: number;
  original?: string;
  translation?: string;
  /** Translator self-flags — surfaced in the user view. */
  flags?: string[];
}

export interface JobProgress {
  currentStage: string;
  commentary?: string;
  stages: Record<string, StageProgress>;
  chunks: ChunkProgress[];
}

export interface JobResult {
  output: string;
  wordCount: number;
  totalFixes: number;
  corrections: Array<{ from: string; to: string; rule: string; count: number }>;
  /** Total translator self-flags across all chunks. Surfaced in the user view. */
  flagsCount: number;
  translationId: string;
}

export interface JobDocument {
  status: 'pending' | 'running' | 'completed' | 'failed';
  uid: string;
  email: string;
  input: PipelineInput;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  progress: JobProgress | null;
  result: JobResult | null;
}

export interface JobProgressUpdate {
  status?: 'running' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  error?: string;
  progress?: Partial<JobProgress> & { currentStage?: string };
  result?: JobResult;
}

export type ProgressReporter = (update: JobProgressUpdate) => Promise<void>;

// ─── Transliteration-first pipeline (page-by-page) ──────────────────────────
//
// Aksharpith's primary product is a Roman-script transliteration of a Gujarati
// document. Translation to English is an optional secondary stage triggered by
// the user from the transliteration view.
//
// Big PDFs are processed page-by-page: one Sonnet vision call per page, max 3
// in flight, full text assembled at the end. The existing verse-aware chunker
// then runs over the assembled Gujarati to produce semantic chunks for the
// transliterator (and optionally the translator).

export type PageStatus = 'pending' | 'ocr_running' | 'ocr_done' | 'ocr_failed';

export interface PageJob {
  pageNum: number;                  // 1-indexed page number in the source PDF
  status: PageStatus;
  attempts: number;                 // OCR retry counter, capped at 3
  claimedBy?: string;               // worker process id holding the lock
  claimedAt?: string;               // ISO — for stale-claim reaper
  gujaratiText?: string;            // populated when status = 'ocr_done'
  /** Per-page Roman transliteration. Populated by the transliterator stage
   *  AFTER all pages are OCR'd. The UI uses this to render per-page
   *  collapsible sections; the doc-level `transliteratedOutput` is still
   *  written on the parent for downloads and admin overview. */
  transliteratedText?: string;
  wordCount?: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export type TransliterationJobStatus =
  | 'pending'         // parent created, no pages claimed yet
  | 'ocr_running'     // at least one page in flight
  | 'assembling'      // all pages done, joining text
  | 'transliterating' // running chunker → transliterator → enforcer
  | 'done'            // transliteration complete; translation may be pending
  | 'failed';         // unrecoverable — see `error`

export type TranslationStatus = 'idle' | 'pending' | 'running' | 'done' | 'failed';

export interface TransliterationJobDocument {
  /** Discriminator vs `JobDocument` (legacy translation-only jobs). */
  kind: 'transliteration';

  uid: string;
  email: string;

  // Source
  filename: string;
  /** Vercel Blob URL for the original PDF (only for PDF inputs). */
  pdfBlobUrl?: string;
  /** Inline source text — populated for paste / .txt / .docx inputs (no OCR). */
  pasteText?: string;
  totalPages: number;               // 1 for non-PDF inputs

  // Parent state
  status: TransliterationJobStatus;
  pagesCompleted: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;

  // Outputs
  /** Assembled Gujarati after all pages OCR'd and joined. */
  gujaratiOutput?: string;
  /** Primary product — Roman transliteration with ā-only diacritics. */
  transliteratedOutput?: string;

  // Optional secondary translation stage
  translateRequested?: boolean;
  translationStatus?: TranslationStatus;
  translationOutput?: string;
  translationError?: string;
}
