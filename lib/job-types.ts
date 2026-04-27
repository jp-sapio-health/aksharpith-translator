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
  // Reviewer-derived fields (kept optional for one PR cycle of revert safety;
  // the translator/smoother critical path no longer populates them).
  certCount?: number;
  avgScore?: number;
  rechecked?: number;
  flaggedChunks?: number;
}

export interface ChunkProgress {
  index: number;
  original?: string;
  translation?: string;
  /** Translator self-flags — surfaced in the user view. */
  flags?: string[];
  // ─── Deprecated (admin-only) ──────────────────────────────────────────
  // Reviewer fields are populated only when ENABLE_REVIEWER_TELEMETRY=true
  // and only on the Firestore document — the user-facing response strips
  // them. Kept optional for revert safety.
  /** @deprecated reviewer score 0–100 — admin-only when enabled */
  score?: number;
  /** @deprecated reviewer certification — admin-only when enabled */
  certifiable?: boolean;
  /** @deprecated reviewer categories — admin-only when enabled */
  categories?: Array<{ id: string; weight: number; score: number; deductions: string[]; pass: boolean }>;
  /** @deprecated reviewer pitfalls — admin-only when enabled */
  pitfalls?: string[];
  /** @deprecated reviewer issues — admin-only when enabled */
  issues?: string[];
  /** @deprecated reviewer score history — admin-only when enabled */
  scoreHistory?: number[];
  /** @deprecated reviewer round count — admin-only when enabled */
  reviewRound?: number;
  /** @deprecated reviewer running flag — admin-only when enabled */
  reviewing?: boolean;
  /** @deprecated smoother fallback flag (replaced by inline progress commentary) */
  flagged?: boolean;
}

export interface JobProgress {
  currentStage: string;
  commentary?: string;
  stages: Record<string, StageProgress>;
  chunks: ChunkProgress[];
}

export interface ReviewerSummaryData {
  avgScore: number;
  certifiedCount: number;
  totalChunks: number;
  categories: Array<{ id: string; weight: number; avgScore: number }>;
  totalDeductions: number;
  topIssues: string[];
}

export interface JobResult {
  output: string;
  wordCount: number;
  totalFixes: number;
  corrections: Array<{ from: string; to: string; rule: string; count: number }>;
  /** Total translator self-flags across all chunks. Surfaced in the user view. */
  flagsCount: number;
  translationId: string;
  // ─── Deprecated (admin-only) ──────────────────────────────────────────
  /** @deprecated reviewer-derived avg score; populated only when telemetry is on, never in user response */
  avgScore?: number;
  /** @deprecated reviewer-derived summary; populated only when telemetry is on, never in user response */
  reviewerSummary?: ReviewerSummaryData;
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
