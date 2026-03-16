import type { TerminologyRule } from './types';

export const TERMINOLOGY_RULES: TerminologyRule[] = [
  { pattern: /\bsaints\b/gi, replacement: (m: string) => m[0] === 'S' ? 'Swamis' : 'swamis', rule: 'saint(s)\u2192Swami(s)' },
  { pattern: /\bsaint\b/gi, replacement: (m: string) => m[0] === 'S' ? 'Swami' : 'swami', rule: 'saint\u2192Swami' },
  { pattern: /\bmonks\b/gi, replacement: (m: string) => m[0] === 'M' ? 'Swamis' : 'swamis', rule: 'monk(s)\u2192Swami(s)' },
  { pattern: /\bmonk\b/gi, replacement: (m: string) => m[0] === 'M' ? 'Swami' : 'swami', rule: 'monk\u2192Swami' },
  { pattern: /\btemples\b/gi, replacement: (m: string) => m[0] === 'T' ? 'Mandirs' : 'mandirs', rule: 'temple(s)\u2192mandir(s)' },
  { pattern: /\btemple\b/gi, replacement: (m: string) => m[0] === 'T' ? 'Mandir' : 'mandir', rule: 'temple\u2192mandir' },
  { pattern: /\bharibhaktas\b/gi, replacement: 'devotees', rule: 'haribhakta(s)\u2192devotee(s)' },
  { pattern: /\bharibhakta\b/gi, replacement: 'devotee', rule: 'haribhakta\u2192devotee' },
  { pattern: /\bfollowers\b/gi, replacement: (m: string) => m[0] === 'F' ? 'Devotees' : 'devotees', rule: 'follower(s)\u2192devotee(s)' },
  { pattern: /\bfollower\b/gi, replacement: (m: string) => m[0] === 'F' ? 'Devotee' : 'devotee', rule: 'follower\u2192devotee' },
  { pattern: /\bpenance\b/gi, replacement: 'austerities', rule: 'penance\u2192austerities' },
  { pattern: /\btorchbearer\b/gi, replacement: 'successor', rule: 'torchbearer\u2192successor' },
  { pattern: /\baarti\b/gi, replacement: 'arti', rule: 'aarti\u2192arti' },
  { pattern: /\bvicharan\b/gi, replacement: 'vichran', rule: 'vicharan\u2192vichran' },
  { pattern: /\bdhotiyos\b/gi, replacement: 'dhotiyas', rule: 'dhotiyos\u2192dhotiyas' },
  { pattern: /\bBrahmic state\b/gi, replacement: 'brahmisthiti', rule: 'Brahmic state\u2192brahmisthiti' },
  { pattern: /\bscriptures\b/gi, replacement: (m: string) => m[0] === 'S' ? 'Shastras' : 'shastras', rule: 'scripture(s)\u2192shastra(s)' },
  { pattern: /\bscripture\b/gi, replacement: (m: string) => m[0] === 'S' ? 'Shastra' : 'shastra', rule: 'scripture\u2192shastra' },
  { pattern: /\bcongregation\b/gi, replacement: 'satsang', rule: 'congregation\u2192satsang' },
  { pattern: /\bHindu mythology\b/gi, replacement: 'Hindu sacred history', rule: 'Hindu mythology\u2192Hindu sacred history' },
  { pattern: /\bmythology\b/gi, replacement: 'sacred history', rule: 'mythology\u2192sacred history' },
  { pattern: /\bLord Swaminarayan\b/g, replacement: 'Bhagwan Swaminarayan', rule: 'Lord Swaminarayan\u2192Bhagwan Swaminarayan' },
  { pattern: /\bdivine abode\b/gi, replacement: 'Akshardham', rule: 'divine abode\u2192Akshardham' },
  { pattern: /\bShrijimaharaj\b/g, replacement: 'Shriji Maharaj', rule: 'Shrijimaharaj\u2192Shriji Maharaj' },
  { pattern: /\bShri Ji Maharaj\b/g, replacement: 'Shriji Maharaj', rule: 'Shri Ji Maharaj\u2192Shriji Maharaj' },
];

export const PERSONAL_NAME_RULES: TerminologyRule[] = [
  { pattern: /\bBhilalbhai\b/g, replacement: 'Bhailalbhai', rule: 'Bhilalbhai\u2192Bhailalbhai' },
  { pattern: /\bNarayanda\b/g, replacement: 'Naran\u2019da', rule: 'Narayanda\u2192Naran\u2019da' },
  { pattern: /\bNaranda\b/g, replacement: 'Naran\u2019da', rule: 'Naranda\u2192Naran\u2019da' },
];

export const PLACE_NAME_RULES: TerminologyRule[] = [
  { pattern: /\bPipalana\b/g, replacement: 'Piplana', rule: 'Pipalana\u2192Piplana' },
  { pattern: /\bChanasad\b/g, replacement: 'Chansad', rule: 'Chanasad\u2192Chansad' },
  { pattern: /\bBamangaon\b/g, replacement: 'Bamangam', rule: 'Bamangaon\u2192Bamangam' },
  { pattern: /\bDholiya\b/g, replacement: 'Dhuliya', rule: 'Dholiya\u2192Dhuliya' },
  { pattern: /\bDungara\b/g, replacement: 'Dangara', rule: 'Dungara\u2192Dangara' },
  { pattern: /\bBhadarod\b/g, replacement: 'Bhadrod', rule: 'Bhadarod\u2192Bhadrod' },
  { pattern: /\bChokshi\b/g, replacement: 'Choksi', rule: 'Chokshi\u2192Choksi' },
];

export const DIACRITICS_MAP: Record<string, string> = {
  '\u1e41': 'm',    // ṁ
  '\u1e6d': 't',    // ṭ
  '\u1e63': 'sh',   // ṣ
  '\u015b': 'sh',   // ś
  '\u1e47': 'n',    // ṇ
  '\u012b': 'i',    // ī
  '\u016b': 'u',    // ū
  '\u1e5b': 'r',    // ṛ
  '\u1e45': 'n',    // ṅ
  '\u1e0d': 'd',    // ḍ
  '\u0127': 'h',    // ħ
  '\u00f1': 'n',    // ñ
};
