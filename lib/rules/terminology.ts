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
  // F-02: sadhus used for BAPS ascetics
  { pattern: /\bsadhus\b/gi, replacement: (m: string) => m[0] === 'S' ? 'Swamis' : 'swamis', rule: 'sadhu(s)\u2192Swami(s)' },
  { pattern: /\bsadhu\b/gi, replacement: (m: string) => m[0] === 'S' ? 'Swami' : 'swami', rule: 'sadhu\u2192Swami' },
  // F-03: sannyasis for impostors
  { pattern: /\bsannyasis\b/gi, replacement: 'bawas', rule: 'sannyasis\u2192bawas' },
  { pattern: /\bsannyasi\b/gi, replacement: 'bawa', rule: 'sannyasi\u2192bawa' },
  // F-05: run-to-run term variation
  { pattern: /\bavatari personage\b/gi, replacement: 'avatari Purush', rule: 'avatari personage\u2192avatari Purush' },
  { pattern: /\bavataric Purush\b/g, replacement: 'avatari Purush', rule: 'avataric Purush\u2192avatari Purush' },
  // Additional mandatory terminology
  { pattern: /\bfellowship\b/gi, replacement: 'satsang', rule: 'fellowship\u2192satsang' },
  { pattern: /\brecitation\b/gi, replacement: 'mukhpath', rule: 'recitation\u2192mukhpath' },
];

export const PERSONAL_NAME_RULES: TerminologyRule[] = [
  { pattern: /\bBhilalbhai\b/g, replacement: 'Bhailalbhai', rule: 'Bhilalbhai\u2192Bhailalbhai' },
  { pattern: /\bNarayanda\b/g, replacement: 'Naran\u2019da', rule: 'Narayanda\u2192Naran\u2019da' },
  { pattern: /\bNaranda\b/g, replacement: 'Naran\u2019da', rule: 'Naranda\u2192Naran\u2019da' },
];

// F-01: Historical name corrections (era-correct names)
export const PLACE_NAME_RULES: TerminologyRule[] = [
  { pattern: /\bPipalana\b/g, replacement: 'Piplana', rule: 'Pipalana\u2192Piplana' },
  { pattern: /\bChanasad\b/g, replacement: 'Chansad', rule: 'Chanasad\u2192Chansad' },
  { pattern: /\bBamangaon\b/g, replacement: 'Bamangam', rule: 'Bamangaon\u2192Bamangam' },
  { pattern: /\bDholiya\b/g, replacement: 'Dhuliya', rule: 'Dholiya\u2192Dhuliya' },
  { pattern: /\bDungara\b/g, replacement: 'Dangara', rule: 'Dungara\u2192Dangara' },
  { pattern: /\bBhadarod\b/g, replacement: 'Bhadrod', rule: 'Bhadarod\u2192Bhadrod' },
  { pattern: /\bChokshi\b/g, replacement: 'Choksi', rule: 'Chokshi\u2192Choksi' },
  { pattern: /\bMumbai Province\b/g, replacement: 'Bombay Province', rule: 'Mumbai Province\u2192Bombay Province' },
  { pattern: /\bSaurashtra\b/g, replacement: 'Kathiawad', rule: 'Saurashtra\u2192Kathiawad' },
];

// Forbidden vocabulary — flagged (not removed, since some are context-dependent)
export const FORBIDDEN_VOCAB_RULES: TerminologyRule[] = [
  { pattern: /\blegendary\b/gi, replacement: 'renowned', rule: 'forbidden: legendary\u2192renowned' },
  { pattern: /\bcharismatic\b/gi, replacement: 'inspiring', rule: 'forbidden: charismatic\u2192inspiring' },
  { pattern: /\brevolutionary\b/gi, replacement: 'transformative', rule: 'forbidden: revolutionary\u2192transformative' },
  { pattern: /\brevolutionised\b/gi, replacement: 'transformed', rule: 'forbidden: revolutionised\u2192transformed' },
  { pattern: /\bprogressive\b/gi, replacement: 'devoted', rule: 'forbidden: progressive\u2192devoted' },
  { pattern: /\bhumanitarian\b/gi, replacement: 'compassionate', rule: 'forbidden: humanitarian\u2192compassionate' },
  { pattern: /\bempowerment\b/gi, replacement: 'spiritual strength', rule: 'forbidden: empowerment\u2192spiritual strength' },
  { pattern: /\bstakeholder\b/gi, replacement: 'devotee', rule: 'forbidden: stakeholder\u2192devotee' },
  { pattern: /\brole model\b/gi, replacement: 'ideal', rule: 'forbidden: role model\u2192ideal' },
  { pattern: /\bmilestone\b/gi, replacement: 'occasion', rule: 'forbidden: milestone\u2192occasion' },
  { pattern: /\blife-changing\b/gi, replacement: 'spiritually transformative', rule: 'forbidden: life-changing' },
];

// Hedging phrases — removed to preserve doctrinal authority
export const HEDGING_RULES: TerminologyRule[] = [
  { pattern: /\bIt seems that\b/gi, replacement: '', rule: 'hedging removed: "It seems that"' },
  { pattern: /\bit seems\b/gi, replacement: '', rule: 'hedging removed: "it seems"' },
  { pattern: /\bIt is believed that\b/gi, replacement: '', rule: 'hedging removed: "It is believed that"' },
  { pattern: /\bit is said that\b/gi, replacement: '', rule: 'hedging removed: "it is said that"' },
  { pattern: /\bPerhaps\b/g, replacement: '', rule: 'hedging removed: "Perhaps"' },
  { pattern: /\bperhaps\b/g, replacement: '', rule: 'hedging removed: "perhaps"' },
  { pattern: /\bprobably\b/gi, replacement: '', rule: 'hedging removed: "probably"' },
];

// R-06: American date format → British date format
export const DATE_FORMAT_RULES: TerminologyRule[] = [
  { pattern: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/g, replacement: '$2 $1 $3', rule: 'American date\u2192British date format' },
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
