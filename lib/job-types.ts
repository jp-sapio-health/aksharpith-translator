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
