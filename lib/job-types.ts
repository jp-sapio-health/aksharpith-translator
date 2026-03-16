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
  certCount?: number;
  avgScore?: number;
  rechecked?: number;
  flaggedChunks?: number;
  totalFixes?: number;
}

export interface ChunkProgress {
  index: number;
  original?: string;
  translation?: string;
  score?: number;
  certifiable?: boolean;
  categories?: Array<{ id: string; weight: number; score: number; deductions: string[]; pass: boolean }>;
  pitfalls?: string[];
  issues?: string[];
  scoreHistory?: number[];
  reviewRound?: number;
  reviewing?: boolean;
  flagged?: boolean;
}

export interface JobProgress {
  currentStage: string;
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
  avgScore: number;
  totalFixes: number;
  corrections: Array<{ from: string; to: string; rule: string; count: number }>;
  reviewerSummary: ReviewerSummaryData;
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
