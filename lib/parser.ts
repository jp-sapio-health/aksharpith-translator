/**
 * Strict XML output parsers for the LLM translator and smoother stages.
 *
 * Why XML and not JSON: the source domain is full of curly quotes (“ ”),
 * en dashes ( – ), nested quotations and verse blocks with line breaks. JSON
 * forced the model to escape all of that, and Sonnet routinely returned
 * malformed JSON with embedded unescaped quotes inside the `revised` field.
 * The previous pipeline hid the failures behind a regex fallback that fabricated
 * a score of 50 — silent corruption.
 *
 * These parsers are strict: either the expected tag is found exactly once and
 * its content extracted verbatim, or we throw with a clear error. There is no
 * fallback. The pipeline retries the call (or fails the chunk) — better than a
 * silent corruption.
 */

export interface TranslatorOutput {
  translation: string;
  flags: string[];
}

export interface SmootherOutput {
  smoothed: string;
}

export interface TransliteratorOutput {
  transliteration: string;
}

export class ParserError extends Error {
  constructor(
    message: string,
    public readonly stage: 'translator' | 'smoother' | 'transliterator',
    public readonly rawPreview: string,
  ) {
    super(message);
    this.name = 'ParserError';
  }
}

/**
 * Strip markdown code fences and trim, so we tolerate a model that wraps its
 * output in ``` despite the prompt telling it not to. Idempotent.
 */
function stripFences(raw: string): string {
  let s = raw.trim();
  // Match an opening fence on its own line (optionally with a language tag) and a closing fence.
  // Greedy match anchored to start/end so we strip an outer fence pair only.
  const fenceMatch = s.match(/^```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  if (fenceMatch) s = fenceMatch[1].trim();
  return s;
}

/**
 * Extract content between <tag>...</tag>. Throws ParserError if the tag is
 * missing, unclosed, or appears more than once. Used for tags that must appear
 * exactly once.
 */
function extractSingleTag(
  source: string,
  tag: string,
  stage: 'translator' | 'smoother' | 'transliterator',
): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;

  const firstOpen = source.indexOf(open);
  if (firstOpen === -1) {
    throw new ParserError(
      `Missing <${tag}> opening tag`,
      stage,
      source.slice(0, 200),
    );
  }
  const lastOpen = source.lastIndexOf(open);
  if (lastOpen !== firstOpen) {
    throw new ParserError(
      `Multiple <${tag}> opening tags`,
      stage,
      source.slice(0, 200),
    );
  }

  const closeIdx = source.indexOf(close, firstOpen + open.length);
  if (closeIdx === -1) {
    throw new ParserError(
      `Missing </${tag}> closing tag`,
      stage,
      source.slice(0, 200),
    );
  }
  // No second closing tag.
  const lastClose = source.lastIndexOf(close);
  if (lastClose !== closeIdx) {
    throw new ParserError(
      `Multiple </${tag}> closing tags`,
      stage,
      source.slice(0, 200),
    );
  }

  return source.slice(firstOpen + open.length, closeIdx).trim();
}

/**
 * Extract zero or more <flag>...</flag> entries from a <flags> block. Empty
 * <flags></flags> is valid (no low-confidence spans). Tolerates whitespace and
 * newlines between tags.
 */
function extractFlags(flagsBlock: string): string[] {
  const out: string[] = [];
  const re = /<flag>([\s\S]*?)<\/flag>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flagsBlock)) !== null) {
    const text = m[1].trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * Parse the translator's XML response.
 *
 * Expected format (strict):
 *   <translation>...</translation>
 *   <flags>
 *     <flag>...</flag>
 *     ...
 *   </flags>
 *
 * Whitespace and a single outer ``` fence are tolerated. An empty <flags></flags>
 * is valid and yields flags: [].
 */
export function parseTranslator(raw: string): TranslatorOutput {
  if (typeof raw !== 'string') {
    throw new ParserError('Empty or non-string translator output', 'translator', String(raw));
  }
  const cleaned = stripFences(raw);
  if (!cleaned) {
    throw new ParserError('Empty translator output', 'translator', '');
  }

  const translation = extractSingleTag(cleaned, 'translation', 'translator');
  if (!translation) {
    throw new ParserError(
      'Empty <translation> block',
      'translator',
      cleaned.slice(0, 200),
    );
  }

  const flagsBlock = extractSingleTag(cleaned, 'flags', 'translator');
  const flags = extractFlags(flagsBlock);

  return { translation, flags };
}

/**
 * Parse the smoother's XML response.
 *
 * Expected format (strict):
 *   <smoothed>...</smoothed>
 */
export function parseSmoother(raw: string): SmootherOutput {
  if (typeof raw !== 'string') {
    throw new ParserError('Empty or non-string smoother output', 'smoother', String(raw));
  }
  const cleaned = stripFences(raw);
  if (!cleaned) {
    throw new ParserError('Empty smoother output', 'smoother', '');
  }

  const smoothed = extractSingleTag(cleaned, 'smoothed', 'smoother');
  if (!smoothed) {
    throw new ParserError(
      'Empty <smoothed> block',
      'smoother',
      cleaned.slice(0, 200),
    );
  }
  return { smoothed };
}

/**
 * Parse the transliterator's XML response.
 *
 * Expected format (strict):
 *   <transliteration>...</transliteration>
 *
 * The block may contain <verse>…</verse> markup which the renderer uses to
 * italicise verse lines; we leave that markup intact in the returned string
 * so downstream code (DOCX writer, UI) can interpret it. Plain prose is
 * returned verbatim.
 */
export function parseTransliterator(raw: string): TransliteratorOutput {
  if (typeof raw !== 'string') {
    throw new ParserError('Empty or non-string transliterator output', 'transliterator', String(raw));
  }
  const cleaned = stripFences(raw);
  if (!cleaned) {
    throw new ParserError('Empty transliterator output', 'transliterator', '');
  }

  const transliteration = extractSingleTag(cleaned, 'transliteration', 'transliterator');
  if (!transliteration) {
    throw new ParserError(
      'Empty <transliteration> block',
      'transliterator',
      cleaned.slice(0, 200),
    );
  }
  return { transliteration };
}
