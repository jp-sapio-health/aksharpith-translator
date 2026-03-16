export interface HouseRuleSection {
  id: number;
  title: string;
  rules: string[];
}

export const HOUSE_RULES: HouseRuleSection[] = [
  {
    id: 1,
    title: 'LANGUAGE & SPELLING',
    rules: [
      'British English with Oxford conventions.',
      'Use -ize endings: organize, realize, recognize.',
      'Use -yse where required: analyse, paralyse, catalyse.',
      'Use British forms: fulfil, travelling, programme (unless software context), colour, honour.',
    ],
  },
  {
    id: 2,
    title: 'DASHES & PUNCTUATION',
    rules: [
      'NEVER use em dashes (\u2014). Always use spaced en dashes ( \u2013 ).',
      'Use curly double speech marks (\u201c \u201d) for ALL quotations, speech, verse transliterations, book titles.',
      'Nested quotes: \u201cSwamishri said, \u2018Prapti is 24 hours.\u2019\u201d',
      'Never use straight quotation marks (\' or ").',
      'Footnotes end with full stops if they are complete sentences. Maintain formal tone; no casual phrasing.',
    ],
  },
  {
    id: 3,
    title: 'DIACRITICS (HIGHLY RESTRICTED)',
    rules: [
      'The ONLY diacritical mark permitted ANYWHERE is \u0101 (a with macron).',
      '\u0101 may ONLY appear when directly quoting poetic/canonical verses.',
      'NEVER use: \u1e41 \u1e6d \u1e63 \u015b \u1e47 \u012b \u016b \u1e5b \u1e45 \u1e0d \u0127 or any other diacritical mark.',
      'In prose: prapti, bhakti, anand, murti (absolutely no diacritics).',
    ],
  },
  {
    id: 4,
    title: 'MANDATORY TERMINOLOGY',
    rules: [
      'mandir (NEVER "temple") | Swami/Swamis (NEVER "saint/sadhu" for BAPS ascetics)',
      'bawa/bawas (for impostor ascetics) | devotee(s) (NEVER "haribhakta")',
      'Akshardham (NEVER "divine abode") | Shriji Maharaj (two words)',
      'Bhagwan Swaminarayan (NEVER "Lord Swaminarayan")',
      'austerities (NEVER "penance") | successor (NEVER "torchbearer")',
      'arti (NEVER "aarti") | vichran (NEVER "vicharan")',
      'shastra (not "scripture" in spiritual context) | seva (not "service" in spiritual context)',
      'satsang (NEVER "fellowship") | mukhpath (NEVER "recitation")',
      'santmandal (collective group of saints) | brahmisthiti (NEVER "Brahmic state")',
      'dhotiyas (NEVER "dhotiyos") | Piplana (NEVER "Pipalana")',
      'Swamishri (after first reference to Mahant Swami Maharaj or Pramukh Swami Maharaj)',
    ],
  },
  {
    id: 5,
    title: 'TITLES & HONORIFICS',
    rules: [
      'First reference: Mahant Swami Maharaj / Pramukh Swami Maharaj.',
      'After introduction: Swamishri (preferred).',
      'Avoid casual shortening.',
    ],
  },
  {
    id: 6,
    title: 'TRANSLATION FIDELITY (Core Rule)',
    rules: [
      'Preserve meaning, sequence, theology, emotional tone, numbers, dates, time stamps.',
      'Must NOT: add interpretation, modernise devotional intent, compress theology, paraphrase freely, introduce explanation not present.',
      'ALLOWED improvements: grammar refinement, tense consistency, natural British phrasing, improved clarity, removal of awkward repetition (without altering meaning).',
      'NOT permitted: reframing emphasis, rewriting ideas, editorial embellishment.',
    ],
  },
  {
    id: 7,
    title: 'TONE (Narrative Voice Standards)',
    rules: [
      'Dignified, measured, reverent, clear, intellectually honest, non-sensational.',
      'NEVER: hype, dramatic exaggeration, emotional manipulation, American marketing tone.',
      'NEVER: "mythology" for Hindu texts (use "scripture" or "sacred history").',
      'NEVER: modern management terms (CEO, strategy, stakeholder, roadmap) in historical contexts.',
      'NEVER: "life-changing", "BAPS is proud\u2026", promotional language.',
      'Never flatten devotional intensity. Maintain original tone: devotional, scholarly, narrative, eyewitness, historical.',
    ],
  },
  {
    id: 8,
    title: 'HISTORICAL INTEGRITY',
    rules: [
      'Preserve exact dates in BRITISH format: \u201c3 April 1781\u201d NOT "April 3, 1781".',
      'Preserve exact time stamps (e.g. 2.16 a.m.), all numbers.',
      'Never approximate unless the source approximates. Never infer inner thoughts unless documented.',
      'Use era-correct names: "Bombay Province" not "Mumbai".',
      'Exact place spellings: Chansad, Bamangam, Dhuliya, Dangara, Bhadrod, Piplana.',
    ],
  },
  {
    id: 9,
    title: 'INTERNAL CONSISTENCY',
    rules: [
      'Maintain consistency in spelling, transliteration, capitalisation, hyphenation, time format, and quotation style.',
      'No switching between American and British forms.',
    ],
  },
  {
    id: 10,
    title: 'TRANSPARENCY & ACCURACY',
    rules: [
      'If uncertainty exists, flag it. Do not silently adjust.',
      'Do not assume theological nuance. Do not approximate history.',
      'Accuracy over fluency.',
    ],
  },
];

export function formatHouseRulesForPrompt(): string {
  return HOUSE_RULES.map(section =>
    `${section.id}. ${section.title}:\n${section.rules.map(r => `   - ${r}`).join('\n')}`
  ).join('\n\n');
}
