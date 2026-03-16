// Shared interfaces for the Aksharpith translation pipeline

export interface GlossaryEntry {
  term: string;
  definition: string;
  category: string;
  neverUse?: string[];
}

export interface TerminologyRule {
  pattern: RegExp;
  replacement: string | ((m: string) => string);
  rule: string;
}

export interface ReviewComment {
  id?: string;
  uid: string;
  email: string;
  displayName: string;
  comment: string;
  sectionIndex: number;
  createdAt: string;
}

export interface OutputSection {
  type: 'prose' | 'verse';
  content: string;
  transliteration?: string;
  meaning?: string;
  index: number;
}

export interface TrainingDataEntry {
  translationId: string;
  chunkIndex: number;
  originalGujarati: string;
  pipelineTranslation: string;
  reviewerScore: number;
  reviewerCategories: Array<{ id: string; score: number; weight: number }>;
  comments: ReviewComment[];
  createdAt: string;
}

export interface RulesCorrection {
  from: string;
  to: string;
  rule: string;
  count: number;
}
