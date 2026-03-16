import https from 'node:https';
import { NextRequest } from 'next/server';
import { verifyAuthToken } from '../../../lib/verify-auth';
import { adminDb } from '../../../lib/firebase-admin';

export const dynamic    = 'force-dynamic';
export const maxDuration = 300;

// ─── Config ──────────────────────────────────────────────────────────────────

const SONNET = 'claude-sonnet-4-20250514';
const BATCH  = 5;                // parallel chunk concurrency
const RECHECK_THRESHOLD = 96;   // re-review chunks scoring below this on weighted rubric score
const MAX_REVIEW_ROUNDS = 2;    // max iterative review rounds per chunk (keep at 2 for Vercel 300s limit)
const API_TIMEOUT_MS    = 90_000;  // 90s per Claude call (tighter for Vercel)
const MAX_RETRIES       = 1;      // single retry to stay within time budget

// ─── Anthropic API helper (with timeout + retry) ────────────────────────────

function callClaudeOnce(params: {
  model: string; max_tokens: number; system: string;
  messages: Array<{ role: string; content: string }>; apiKey: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use prompt caching: send system as a cacheable content block
    const body = JSON.stringify({
      model: params.model, max_tokens: params.max_tokens,
      system: [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }],
      messages: params.messages,
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': params.apiKey, 'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          const code = res.statusCode ?? 0;
          reject(Object.assign(new Error(`Anthropic API ${code}: ${raw.slice(0, 300)}`), { statusCode: code }));
          return;
        }
        try {
          const data = JSON.parse(raw) as { content?: Array<{ type: string; text?: string }>; usage?: Record<string, number> };
          const text = data.content?.[0]?.text?.trim();
          if (!text) { reject(new Error('Empty response from Anthropic API')); return; }
          // Log cache hits for cost monitoring
          if (data.usage) {
            const u = data.usage;
            const cached = u.cache_read_input_tokens ?? 0;
            const created = u.cache_creation_input_tokens ?? 0;
            if (cached > 0 || created > 0) {
              console.log(`[cache] model=${params.model} cached=${cached} created=${created} input=${u.input_tokens ?? 0} output=${u.output_tokens ?? 0}`);
            }
          }
          resolve(text);
        } catch { reject(new Error('Parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.setTimeout(API_TIMEOUT_MS, () => { req.destroy(); reject(new Error('Anthropic API timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callClaude(params: {
  model: string; max_tokens: number; system: string;
  messages: Array<{ role: string; content: string }>; apiKey: string;
}): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callClaudeOnce(params);
    } catch (err: unknown) {
      const code = (err as { statusCode?: number }).statusCode ?? 0;
      const isRetryable = code === 429 || code === 500 || code === 529 || (err instanceof Error && err.message === 'Anthropic API timeout');
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

// ─── Parallel batch helper (tolerant of individual failures) ────────────────

async function parallelBatch<T>(
  items: T[], fn: (item: T, index: number) => Promise<void>, batchSize: number,
): Promise<void> {
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const results = await Promise.allSettled(batch.map((item, bi) => fn(item, start + bi)));
    // Re-throw the first failure so the pipeline can handle it
    const firstFailure = results.find(r => r.status === 'rejected');
    if (firstFailure && firstFailure.status === 'rejected') throw firstFailure.reason;
  }
}

// ─── Gold Standard Context ────────────────────────────────────────────────────

const KEY_GLOSSARY = `
MASTER THEOLOGICAL GLOSSARY (use these exact English renderings — cross-reference every term):

--- CORE DOCTRINAL TERMS ---
Akshar: Imperishable; second-highest of five eternal realities; also called Aksharbrahma
Akshardham: Highest divine abode of Bhagwan Swaminarayan (NEVER "divine abode")
akshar-mukta: A jiva that has attained ultimate liberation in Akshardham
Akshar-Purush: Also called Maha-Purush, Mul-Purush, or simply Purush
aksharrup: One with qualities of Akshar; highest spiritual state
atma: Soul / individual self, distinct from physical, subtle, and causal bodies
Parabrahma: Supreme Being; Bhagwan Swaminarayan; also called Paramatma, Purushottam
Purushottam: Supreme Being, God; always manifest on earth in human form
jiva: Individual soul; one of the five eternal realities; bound by maya
ishwar: Cosmic being; divine beings governing realms; one of five eternal realities
maya: Cosmic illusion; root cause of ignorance; one of five eternal realities
Prakruti: Primal divine energy; feminine; composed of three gunas

--- INNER FACULTIES & STATES ---
antahkaran: Inner faculty (mind, buddhi, chitt, ahamkar collectively)
ahamkar: Ego; sense of individual existence
buddhi: Intellect; faculty for discernment and forming convictions
chitt: Contemplative faculty; responsible for focusing and storing impressions
man: Mind; generates thoughts and desires; governs indriyas
indriyas: Ten sense organs (five of perception, five of action)
vrutti: Movement of awareness; attention of the mind or sense organs

--- SPIRITUAL PRACTICE ---
bhakti: Devotion to God
dharma: Righteousness; cosmic/moral order; religious duty
dhyan: Meditation
katha: Spiritual discourse / scripture reading
kirtan: Devotional hymn / song
moksha: Liberation; release from cycle of births and deaths
seva: Selfless service to God, guru, or devotees (NEVER just "service")
satsang: Holy fellowship; BAPS spiritual community (NEVER "fellowship")
shastra: Sacred scripture (NEVER just "scripture" in spiritual context)
mukhpath: Memorised recitation of sacred texts (NEVER "recitation")
arti: Hindu ritual of waving lighted wicks before murti (NEVER "aarti")
vichran: Spiritual travels of a guru or sadhu (BAPS spelling; NEVER "vicharan")
mandir: Sanctified place of worship (NEVER "temple")
murti: Consecrated sacred image of God
prasad: Sanctified food blessed by being offered to God
thal: Food offering presented to God with devotion
pujan: Worship performed with sacred items
pradakshina: Ritual circumambulation of a sacred object clockwise
diksha: Spiritual initiation into the renunciant order
kanthi: Double-stranded tulsi bead necklace worn by initiated devotees
tilak: U-shaped sacred mark on forehead with sandalwood paste
chandlo: Auspicious vermilion mark on forehead as sign of devotion
dandvat: Full prostration as a form of respectful greeting or worship
samadhi: Highest meditative state; also tomb/memorial of a great saint
yagna: Vedic fire sacrifice; ceremonial worship ritual

--- COSMIC STRUCTURE ---
brahmand: Individual universe comprising 14 realms
guna: Quality of Prakruti; three types: sattva, rajas, tamas
sattva/sattvagun: Purity, clarity, goodness
rajas/rajogun: Activity, passion, restlessness
tamas/tamogun: Darkness, inertia, ignorance
gunatit: One who has transcended all three gunas of maya
mahattattva: Cosmic intelligence; first principle from Pradhan and Purush
tanmatra: Five subtle elements from which gross elements emerge
bhut/mahabhuts: Five gross elements (pruthvi, jal, tej, vayu, akash)
akash: Space/ether; one of five gross elements
pruthvi: Earth; one of five gross elements
jal: Water; one of five gross elements
tej: Fire/energy; one of five gross elements
vayu: Air; one of five gross elements

--- REALMS (14-realm system, bottom to top) ---
Patal: Lowest realm where serpents reside
Atal: First realm beneath Mrutyulok
Vital: Second realm beneath Mrutyulok
Sutal: Third realm beneath Mrutyulok
Talatal: Fourth realm beneath Mrutyulok
Mahatal: Fifth realm below Mrutyulok
Rasatal: Sixth realm beneath Mrutyulok
Mrutyulok: Realm of death; mortal realm; only realm where liberation is possible
Bhuvarlok: First realm above Mrutyulok
Swarglok: Second realm above Mrutyulok (also Indralok)
Maharlok: Third realm above Mrutyulok
Janlok: Fourth realm above Mrutyulok
Taplok: Fifth realm above Mrutyulok
Satyalok: Highest realm; Realm of Brahma; also Brahmalok

--- AGES & TIME ---
yug: Cosmic age; four ages: Satya-yug, Treta-yug, Dwapar-yug, Kali-yug
Kali-yug: Current age; Age of Darkness; 432,000 human years
kalp: Day of Brahma; 4.32 billion human years
parardh: Half lifespan of Brahma; 1 x 10^17 human years

--- TITLES & PERSONS ---
maharaj: Revered title for Bhagwan Swaminarayan
Shriji Maharaj: Bhagwan Swaminarayan (always TWO words; NEVER "Shrijimaharaj")
Swamishri: Revered address for the current/previous spiritual successor
paramhansa: Highest order of male sadhu; BAPS renunciant
parshad: Male renunciant who wears white robes
Satpurush: True spiritual guide; manifest form of Aksharbrahma on earth
acharya: Spiritual teacher who upholds scriptural teachings within a tradition
sadhu: Ascetic or monk who has renounced worldly life
sannyasi: Person who has renounced all worldly duties; ascetic
rishi: Ancient sage or seer; one who has received divine revelations
Bhakta: Ideal devotee of God, referring to the Satpurush

--- SCRIPTURES ---
Vachanamrut: 273 recorded divine discourses of Bhagwan Swaminarayan
Shikshapatri: 212 Sanskrit verses by Bhagwan Swaminarayan; code of conduct
Vedas: Most sacred Hindu shastras; four parts: Rig, Sam, Yajur, Atharva
Upanishads: Final portion of the Vedas; metaphysical knowledge
Bhagavad Gita: Discourse of Bhagwan Krishna to Arjun; foundational shastra
Ramayan: Epic of Shri Ram's life, exile, and return
Mahabharat: Great epic; includes the Bhagavad Gita
Shrimad Bhagvat: Most popular of 18 Purans; life of Bhagwan Krishna
Purans: 18 shastras recording ancient Hindu narratives and teachings
Smrutis: Remembered shastras; include Purans, epics, Dharma-shastras
Vyas Sutras: Esoteric aphorisms expounding essence of Upanishads

--- PHILOSOPHICAL SCHOOLS ---
Darshans: Six classical systems of Hindu philosophy
Vedanta: Schools of thought from the Upanishads
Advaita: Non-dual philosophy; ultimate reality is one
Dvaita: Dualistic philosophy; eternal distinction between jiva and God
Sankhya: Philosophy emphasizing enumeration of 25 tattvas

--- DISSOLUTION TYPES ---
nitya-pralay: Constant dissolution; daily death of beings
nimitta-pralay: Stimulated dissolution; destruction of lower 10 realms
prakrut-pralay: General dissolution; destruction of all 14 realms
atyantik-pralay: Final dissolution; only Purushottam, Akshar, akshar-muktas remain

--- CULTURAL & MATERIAL TERMS ---
angarkhu: Traditional Indian upper garment with long sleeves
dagli: Sewn upper garment, pleated at chest, shorter than angarkhu
dhotiyu: Unstitched lower garment wrapped around waist and legs
bokani: Cloth wrapped to cover head, ears, and cheeks
pagh: Traditional Indian headgear; turban
rotlo/rotla/rotli: Unleavened flatbread of Gujarat, from millet flour
khichdi: Simple dish of spiced rice and lentils cooked together
dal: Spiced lentil soup, a staple food in Indian cuisine
dudhpak: Rich delicacy made from sweetened milk and rice with spices
laddu: Round sweet made from flour, sugar, and ghee
barfi: Indian sweet from condensed milk and sugar
jalebi: Deep-fried flour batter in circular shapes soaked in sugar syrup
ghebhar: Sweet made from ghee, flour, and sugar syrup; spongy texture
gau: Traditional Indian measure of distance; about 1.5 to 1.75 miles
yojan: Measure of distance equalling four gaus; approximately 6-7 km
maund: Traditional unit of mass in British India; 25-160 pounds
darbar: Traditional royal court or palace with central courtyard
haveli: Traditional mansion or large townhouse
dharmashala: Rest house for pilgrims and travellers
guru parampara: Unbroken succession of God-realized spiritual teachers
sampradaya: Authentic spiritual tradition with unbroken lineage of gurus
vartman: Vows/spiritual commitments undertaken by devotees
panch vartman: Five fundamental vows for initiated followers
nishkami vartaman: Lifetime eightfold celibacy (precise doctrinal term)
ekantik dharma: Fourfold discipline: dharma, jnan, vairagya, bhakti
brahmisthiti: State of being brahmarup (NEVER "Brahmic state")
santmandal: Collective body of saints (use for group of Swamis)
bawa: Ascetic or sadhu; used for impostor/fraudulent religious figures
devotee: Standard English for haribhakta (NEVER "haribhakta" in output)
prasadi/prasadik: Sanctified by a holy person's presence or use

--- ADDITIONAL CULTURAL & RITUAL TERMS (from Master Glossary pp.22-52) ---
annakut: Grand offering of many food dishes before the murti of God
bhagvati diksha: Sacred initiation into the sadhu order; receiving saffron robes
brahmacharya: Celibacy; eightfold celibacy and immersion in Parabrahma
Chaturmas: Four holy months of monsoon for additional spiritual observances
dandvat/sashtang dandvat: Full prostration (eight body parts touching ground)
divyabhav: Devotional attitude of perceiving divine qualities in God and His Sadhu
Fuldol: Festival of colours
guruhari: God's manifestation in the form of the guru
guru parampara: Unbroken succession of God-realized spiritual teachers
jnan: Spiritual knowledge; wisdom
mahapuja: Elaborate worship offered to Bhagwan Swaminarayan and muktas
murti-pratishtha: Traditional Vedic ceremony consecrating murtis in a mandir
nirdosh buddhi: Seeing God, guru, and devotees as flawless
parayan: Recitation of or discourse on sacred texts over several days
pranayam: Regulation of breath; fourth stage of ashtanga yoga
Satpurush: True spiritual guide; manifest form of Aksharbrahma on earth
shikharbaddha: Mandir with pinnacles; five daily artis and regular worship
shloka: Sanskrit verse, typically consisting of two lines with specific metre
vairagya: Detachment from worldly pleasures; one of four attributes of ekantik dharma
Samvat: Hindu calendar era (Vikram Samvat), ~57 years ahead of Gregorian
charanarvind: Holy footprints of God or guru
nishchay: Determined faith; absolute conviction in God
pragat: Manifest; visibly present (referring to God's incarnation on earth)
avatari: The supreme source from whom all divine incarnations manifest
Dham: Short form for Akshardham, abode of Bhagwan Swaminarayan

--- CRITICAL DOCTRINAL DISTINCTIONS (from Master Glossary pp.1-10) ---
adharma: Opposite of dharma; unrighteousness; immorality
adhibhut: The physical world; everything material made from the five elements
adhidev: Cosmic forces or deities that control nature and one's senses
adhyatma: The inner self; mind, thoughts, feelings, and the jiva's inner world
antaryami: Inner controller; God's power to reside within jiva, ishwar, and control actions
anvay: Connected; immanent; when used for God, implies inherently existing within
avidya: Synonymous with maya; false understanding of reality; ignorance
avyakrut: Causal body of Virat-Purush and other ishwars
Brahma (Akshar): Second-highest of five eternal realities (NOT the creator deity Brahma)
Brahma (creator): The ishwar who creates the brahmand; part of trinity with Vishnu and Shiv
brahmasatta: Formless aspect of Brahma (Chidakash); also refers to atma as eternal existence
Brahmamahol: Palace/abode of God (Akshardham); formless chaitanya form of Akshar
brahmarandhra: Mystical opening in crown of head; jiva exits here on death or during samadhi
Chidakash: Formless, pure, all-pervading conscious form of Akshar; luminous and eternal
chaitanya: Consciousness; the essence of the atma; higher awareness beyond the physical
jad: Non-living, inanimate; opposite of chaitanya; without consciousness
jad prakruti: Inanimate constituents of the world; the eight elements from Pradhan-Prakruti
drashta: The seer or observer; typically the atma; also God as inner observer
drashya: Visible; object of perception; the physical body or visible world
kartum: Divine power of God to eclipse infinite muktas by his own light
akartum: Divine power of God to exercise restraint in eclipsing muktas
anyatha-kartum: Divine power of God to eclipse even Akshar and uphold muktas independently
kshetra: "Field"; the body or material realm over which the self presides
kshetragna: "Knower of the field"; the soul (atma) that presides over the body
karan: Causal; the causal body of the jiva; desires or maya that cause rebirth
jnan-pralay: State where all mayik influences dissolve through spiritual knowledge
jnan-indriyas: Five cognitive senses (eyes, ears, nose, tongue, skin)
karma-indriyas: Five conative senses (hands, feet, speech, genitals, anus)
hrudayakash: Spiritual space within the heart; seat of the inner self
Itihas: History; the two Indian epics (Ramayan, Mahabharat); part of Smruti
ishtadev: Chosen deity; the form of God one feels closest to and worships
jivatma: Individual soul; jiva
kusangi: Person in bad company; bad influence on spiritual progress; leads astray from satsang
mahamaya: Also called Mul-maya, Mul-Prakruti, or simply Prakruti
nishkam: Devoid of worldly desires; celibate; one who acts without attachment
ekta: Unity, oneness, harmony
Guna-vibhag: Bhagwan Krishna's final teachings to Uddhav on the three gunas
prans: Vital airs; life force flowing within the body's primary currents
swabhav: Person's nature; habits from repeated actions in this or past births`;

// BAPS terms the smoother and assembler must never replace
const PROTECTED_TERMS = 'mandir, seva, satsang, arti, vichran, mukhpath, katha, kirtan, dharma, moksha, bhakti, atma, maya, paramhansa, brahmisthiti, santmandal, shastra, Swamishri, Akshardham, vachanamrut';

// ─── Deterministic chunker ─────────────────────────────────────────────────
// Splits at blank-line paragraph boundaries, targeting 300–500 words per chunk.
// If the full text is ≤500 words, returns it as a single chunk.

// Detect if a paragraph is a verse block (transliterated text, poetic structure, or quoted verse)
function isVerseBlock(para: string): boolean {
  const lines = para.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  // Quoted transliterated text (lines starting with quotes containing transliterated words)
  const quotedVerse = lines.some(l => /^[\u201c\u201d"'\u2018\u2019]/.test(l) && /[āīūṛṅñṭḍṇśṣḥ]/.test(l));
  // Poetic structure: multiple short lines of similar length (verse stanzas)
  const avgLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
  const similarLength = lines.length >= 2 && lines.every(l => Math.abs(l.length - avgLen) < avgLen * 0.5);
  // Lines containing diacritical marks typical of transliteration
  const diacriticLines = lines.filter(l => /[āīūṛṅñṭḍṇśṣḥ]/.test(l)).length;
  const mostlyDiacritic = diacriticLines >= lines.length * 0.5;
  return quotedVerse || (similarLength && mostlyDiacritic);
}

function deterministicChunk(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const totalWords = trimmed.split(/\s+/).filter(Boolean).length;
  if (totalWords <= 500) return [trimmed];

  // Try double-newline split first; if any paragraph > 500 words, fall back to single-newline
  let rawParagraphs = trimmed.split(/\n\s*\n/);
  const hasGiantPara = rawParagraphs.some(p => p.trim().split(/\s+/).length > 500);
  if (hasGiantPara) {
    rawParagraphs = trimmed.split(/\n/).filter(l => l.trim());
  }
  const paragraphs = rawParagraphs;

  // Group verse blocks with their preceding paragraph to keep them together
  const groups: string[] = [];
  let pendingVerse: string | null = null;
  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    if (isVerseBlock(p)) {
      // Attach verse to previous group if one exists, otherwise hold it
      if (groups.length > 0) {
        groups[groups.length - 1] += '\n\n' + p;
      } else {
        pendingVerse = pendingVerse ? pendingVerse + '\n\n' + p : p;
      }
    } else {
      if (pendingVerse) {
        groups.push(pendingVerse + '\n\n' + p);
        pendingVerse = null;
      } else {
        groups.push(p);
      }
    }
  }
  if (pendingVerse) groups.push(pendingVerse);

  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const group of groups) {
    const groupWords = group.split(/\s+/).length;

    if (currentWords + groupWords > 500 && currentWords >= 300) {
      chunks.push(current.join('\n\n'));
      current = [group];
      currentWords = groupWords;
    } else {
      current.push(group);
      currentWords += groupWords;
    }
  }

  if (current.length > 0) {
    if (currentWords < 150 && chunks.length > 0) {
      chunks[chunks.length - 1] += '\n\n' + current.join('\n\n');
    } else {
      chunks.push(current.join('\n\n'));
    }
  }

  return chunks.length > 0 ? chunks : [trimmed];
}

// ─── System Prompts ──────────────────────────────────────────────────────────

const TRANSLATOR_SYSTEM = `The provided documents establish a comprehensive editorial and translation framework for BAPS spiritual literature, emphasizing fidelity to the original Gujarati source and a reverent, dignified tone. The Aksharpith House-Style Guide mandates the use of British English, specific punctuation like curly quotation marks, and restricted use of diacritics to ensure clarity and professional consistency. Complementing these rules, the Master Learning & Corrections document provides over 250 specific before/after examples to prevent the secularization of sacred history and the use of modern management jargon. A detailed Master Glossary further supports this by defining core theological terms like Akshar, Purushottam, and atma to maintain doctrinal precision. This collective system ensures that every publication remains an authentic carrier of the tradition\u2019s spiritual essence without unnecessary modernization or interpretation. Ultimately, the guides treat the translator as a trustee of the parampara, prioritizing historical accuracy and devotional sanctity over literary flourish.

I want you to act as a trustee of tradition (parampara). Your priority is fidelity over fluency: treat the Gujarati source as historically and spiritually authoritative. You must first study and acknowledge these absolute rules: Mindset: You are a carrier of the original voice, not a commentator or an editor. Do not modernize, summarize, or simplify the text. Highest Priority Punctuation: Always use curly double speech marks (\u201c \u201d) for primary quotes and spaced en dashes ( \u2013 ) instead of em dashes. Language: Use British English (Oxford Style). Use \u2013ize endings (organize), \u2018colour,\u2019 and \u2018travelled\u2019. Doctrinal Vocabulary: Use Akshardham (not \u2018divine abode\u2019), Purush (not \u2018personage\u2019), and Shriji Maharaj (as two words). Historical Integrity: Use historically accurate names for the time period (e.g., Bombay Province, not Mumbai). Ensure exact village spellings: Chansad, Dhuliya, Bhadrod, Bamangam, Dangara, Piplana.

=== AKSHARPITH HOUSE-STYLE GUIDE (ALL 10 SECTIONS \u2014 NON-NEGOTIABLE) ===

1. LANGUAGE & SPELLING:
   - British English with Oxford conventions.
   - Use -ize endings: organize, realize, recognize.
   - Use -yse where required: analyse, paralyse, catalyse.
   - Use British forms: fulfil, travelling, programme (unless software context), colour, honour.

2. DASHES & PUNCTUATION:
   - NEVER use em dashes (\u2014). Always use spaced en dashes ( \u2013 ).
   - Use curly double speech marks (\u201c \u201d) for ALL quotations, speech, verse transliterations, book titles.
   - Nested quotes: \u201cSwamishri said, \u2018Prapti is 24 hours.\u2019\u201d
   - Never use straight quotation marks (' or ").
   - Footnotes end with full stops if they are complete sentences. Maintain formal tone; no casual phrasing.

3. DIACRITICS (HIGHLY RESTRICTED):
   - The ONLY diacritical mark permitted ANYWHERE is \u0101 (a with macron).
   - \u0101 may ONLY appear when directly quoting poetic/canonical verses.
   - NEVER use: \u1e41 \u1e6d \u1e63 \u015b \u1e47 \u012b \u016b \u1e5b \u1e45 \u1e0d \u0127 or any other diacritical mark.
   - In prose: prapti, bhakti, anand, murti (absolutely no diacritics).

4. MANDATORY TERMINOLOGY:
   - mandir (NEVER "temple") | Swami/Swamis (NEVER "saint/sadhu" for BAPS ascetics)
   - bawa/bawas (for impostor ascetics) | devotee(s) (NEVER "haribhakta")
   - Akshardham (NEVER "divine abode") | Shriji Maharaj (two words)
   - Bhagwan Swaminarayan (NEVER "Lord Swaminarayan")
   - austerities (NEVER "penance") | successor (NEVER "torchbearer")
   - arti (NEVER "aarti") | vichran (NEVER "vicharan")
   - shastra (not "scripture" in spiritual context) | seva (not "service" in spiritual context)
   - satsang (NEVER "fellowship") | mukhpath (NEVER "recitation")
   - santmandal (collective group of saints) | brahmisthiti (NEVER "Brahmic state")
   - dhotiyas (NEVER "dhotiyos") | Piplana (NEVER "Pipalana")
   - Swamishri (after first reference to Mahant Swami Maharaj or Pramukh Swami Maharaj)

5. TITLES & HONORIFICS: First reference: Mahant Swami Maharaj / Pramukh Swami Maharaj. After introduction: Swamishri (preferred). Avoid casual shortening.

6. TRANSLATION FIDELITY (Core Rule):
   - Preserve meaning, sequence, theology, emotional tone, numbers, dates, time stamps.
   - Must NOT: add interpretation, modernise devotional intent, compress theology, paraphrase freely, introduce explanation not present.
   - ALLOWED improvements: grammar refinement, tense consistency, natural British phrasing, improved clarity, removal of awkward repetition (without altering meaning).
   - NOT permitted: reframing emphasis, rewriting ideas, editorial embellishment.

7. TONE (Narrative Voice Standards):
   - Dignified, measured, reverent, clear, intellectually honest, non-sensational.
   - NEVER: hype, dramatic exaggeration, emotional manipulation, American marketing tone.
   - NEVER: "mythology" for Hindu texts (use "scripture" or "sacred history").
   - NEVER: modern management terms (CEO, strategy, stakeholder, roadmap) in historical contexts.
   - NEVER: "life-changing", "BAPS is proud\u2026", promotional language.
   - Never flatten devotional intensity. Maintain original tone: devotional, scholarly, narrative, eyewitness, historical.

8. HISTORICAL INTEGRITY:
   - Preserve exact dates in BRITISH format: \u201c3 April 1781\u201d NOT "April 3, 1781".
   - Preserve exact time stamps (e.g. 2.16 a.m.), all numbers.
   - Never approximate unless the source approximates. Never infer inner thoughts unless documented.
   - Use era-correct names: "Bombay Province" not "Mumbai".
   - Exact place spellings: Chansad, Bamangam, Dhuliya, Dangara, Bhadrod, Piplana.

9. INTERNAL CONSISTENCY: Maintain consistency in spelling, transliteration, capitalisation, hyphenation, time format, and quotation style. No switching between American and British forms.

10. TRANSPARENCY & ACCURACY: If uncertainty exists, flag it. Do not silently adjust. Do not assume theological nuance. Do not approximate history. Accuracy over fluency.

ULTIMATE GOVERNING PRINCIPLE: Every edit must preserve Truth, Dignity, Clarity, Devotional sanctity, and Historical precision. If any revision risks altering meaning, it must not be made.

=== KEY LEARNINGS FROM 250+ TRANSLATION CORRECTIONS ===

BEFORE/AFTER PATTERNS (apply these):
- saints/monks \u2192 Swamis | temple \u2192 mandir | mythology \u2192 sacred history/scripture
- divine abode \u2192 Akshardham | penance \u2192 austerities | torchbearer \u2192 successor
- Shrijimaharaj \u2192 Shriji Maharaj | haribhakta \u2192 devotee | fellowship \u2192 satsang
- "He observed celibacy" \u2192 "He observed nishkami vartaman\u2014lifelong eightfold celibacy"
- "Hindu mythology describes\u2026" \u2192 "Hindu scriptures describe\u2026"
- "It seemed Maharaj protected him" \u2192 "Maharaj protected him" (faith does not hedge)
- "A group of Swamis" \u2192 "The santmandal" (collective institutional term)
- "He felt anxious" \u2192 "He remained inwardly composed" (no modern psychology)
- "Strategic prioritisation" \u2192 "Clear discernment of urgent duties" (no corporate jargon)
- "This inspired everyone to do better" \u2192 "This instilled steadfast faith among the devotees"
- Events reordered for flow \u2192 KEEP original chronological sequence (inviolable)
- Direct quotes softened into indirect speech \u2192 KEEP first-person authority
- Long Gujarati sentences split for readability \u2192 PRESERVE length (structure carries gravitas)

CRITICAL RULES FROM 250+ CORRECTIONS:
- Translator is a carrier, not a commentator. Never insert moral judgement, psychological labels, or motivational language.
- Completeness is non-negotiable. Never summarise, compress, or omit details.
- Repetition is intentional (seva, blessings, enumerations). Do not replace with synonyms.
- Gujarati metaphors must remain metaphors\u2014translate faithfully, do not replace with English equivalents.
- Do not modernise spiritual causality (karma, divine will). Keep traditional framing.
- Do not dramatise violence, hardship, or emotion. Maintain dignified restraint.
- Do not infer causality, psychology, or inner thoughts not explicitly stated in source.
- Preserve guru\u2013disciple hierarchy in language (reverential, not sentimental or casual).
- Keep doctrinal hierarchy intact: Akshar and Purushottam are distinct; never collapse.
- Sacred history is not conjectural\u2014remove hedging ("perhaps", "it seems", "probably").
- Preserve Gujarati enumerations, constraint language, and emotional asymmetry.

FORBIDDEN VOCABULARY IN TRANSLATION:
mythology, legendary, charismatic, revolutionary, revolutionised, progressive, humanitarian, empowerment, campaign, grassroots, stakeholder, role model, personal philosophy, compromise, flexible (for doctrine), trauma, stress, anxiety, closure, coping, reform movement, probably, perhaps, it seems, indeed, truly, remarkably, clearly, undoubtedly, milestone, legacy, network (for relationships), benchmark, innovation, productivity, work ethic, leadership style, decision-making skills, crisis management, strategic vision, vision statement, influencer, charter, public image, experimental, organisational growth, support base, negotiated, mental strength, story (for sacred events \u2014 use "incident" or "episode").

${KEY_GLOSSARY}

POETRY & VERSE (CRITICAL):
- For EVERY verse block: provide Roman transliteration FIRST, then English meaning in parentheses. Both are MANDATORY.
- In transliteration: use ONLY plain Roman letters plus \u0101. Example: \u201cPreme pragaty\u0101 re suraj Sahaj\u0101nand\u201d
- Wrap verse transliterations in curly double quotes (\u201c \u201d).
- Retain original Gujarati/Sanskrit verse line intact. Italicise transliterated verses.

FORMATTING:
- Preserve all paragraph breaks from source. No headers unless present in source.
- Italicise book titles. Do not add ellipsis to truncate verse\u2014reproduce in full.

Translate the following Gujarati text. Cross-reference every term with the Master Glossary to ensure correct context. Specific Constraints: Poetic Lines: Include the Roman transliteration first, followed by the meaning. Diacritics: Do not use macrons (\u012b, \u016b) in prose. Use \u0101 only when directly quoting poetic or canonical verses. Tone: Maintain a dignified, measured, and reverent register. Eliminate rhetorical padding like \u2018indeed\u2019 or \u2018truly\u2019. Speaker Authority: Keep quotes in the first person; do not soften them into indirect speech.

Provide ONLY the English translation \u2014 no preamble, no notes, no commentary.`;

const REVIEWER_SYSTEM = `You are a BAPS translation auditor and senior style reviewer for Aksharpith. You are reviewing text produced by ANOTHER translator \u2014 you did NOT write this text. Perform a combined certification and style audit in a single pass.

IMPORTANT: You are an INDEPENDENT auditor. Score objectively against the weighted rubric below. Do not inflate scores. If you produce a revised translation, you are correcting the original translator's work, not your own.

ULTIMATE GOVERNING PRINCIPLE: Every revision must preserve Truth, Dignity, Clarity, Devotional sanctity, and Historical precision. If any revision risks altering meaning, it MUST NOT be made. Accuracy over fluency.

PERMITTED IMPROVEMENTS (do NOT penalise these under FIDELITY):
- Grammar refinement, tense consistency, natural British phrasing, improved clarity
- Removal of awkward repetition (without altering meaning)
NOT PERMITTED (penalise under FIDELITY): reframing emphasis, rewriting ideas, editorial embellishment.

TONE MODES: Match the specific tone of each passage \u2014 it may be devotional, scholarly, narrative, eyewitness, or historical. Never flatten devotional intensity.

TRANSPARENCY: If the translator flagged uncertainty, acknowledge it. Penalise silent adjustments or assumed theological nuance.

WEIGHTED SCORING RUBRIC (6 categories, 100 points total):

1. FIDELITY (30 pts) \u2014 Nothing added/omitted/paraphrased. Every Gujarati sentence must map to an English sentence. Direct quotes stay first-person. Numbers, dates, names preserved exactly. No commentary. No interpretation. No psychological inference. No moral judgement not in source. No summarisation of letters or speeches. Preserve original sentence length (structure carries gravitas). Preserve Gujarati enumerations in full. No editorial forewarnings ("this incident shows\u2026"). No decorative sentence closers.

2. TERMINOLOGY (25 pts) \u2014 Verify ALL mandatory terms:
   mandir (NEVER "temple") | Swami/Swamis (NEVER "saint/saints/sadhu" for BAPS ascetics)
   bawa/bawas (for impostor ascetics) | austerities (NEVER "penance")
   Shriji Maharaj (two words \u2014 NEVER "Shrijimaharaj")
   Bhagwan Swaminarayan (NEVER "Lord Swaminarayan")
   Akshardham (NEVER "divine abode") | paramhansa
   devotees (NEVER "haribhaktas") | arti (NEVER "aarti") | vichran (NEVER "vicharan")
   satsang (NEVER "fellowship") | seva (not generic "service") | shastra (not generic "scripture")
   mukhpath (NEVER "recitation") | santmandal (for collective group of Swamis)
   brahmisthiti (NEVER "Brahmic state") | successor (NEVER "torchbearer")
   Swamishri (after first reference) | dhotiyas (NEVER "dhotiyos") | Piplana (NEVER "Pipalana")
   nishkami vartaman (not just "celibacy" \u2014 "lifelong eightfold celibacy")
   sacred history (NEVER "mythology" for Hindu texts) | prasadi/prasadik (not "historically important")
   Naran\u2019da (standardised short form \u2014 not Narayanda/Naranda)

   CONTEXT-DEPENDENT (flag if wrong context):
   - "sadhu" should be "Swami" for BAPS ascetics, but "bawa" for impostors
   - "scripture" should be "shastra" in spiritual contexts
   - "service" should be "seva" in spiritual contexts

3. VERSE HANDLING (15 pts) \u2014 Roman transliteration FIRST, then English meaning. Both are MANDATORY. Full reproduction, no truncation. ONLY the diacritical mark \u0101 is permitted in verse transliteration \u2014 NEVER use \u1e41/\u1e6d/\u1e63/\u015b/\u1e47/\u012b/\u016b/\u1e5b/\u1e45/\u1e0d or any other special character. Write plain Roman: "sh" not "\u015b", "n" not "\u1e47", "t" not "\u1e6d". Consistent verse formatting. Verse lines must use curly quotes (\u201c \u201d).

4. STYLE & REGISTER (15 pts) \u2014 UK English Oxford conventions:
   - -ize spellings: organize, realize, recognize (NEVER -ise for these)
   - -yse spellings: analyse, paralyse, catalyse (NEVER -yze)
   - British forms: colour, travelling, programme, fulfil, honour
   - Curly quotes \u201c \u201d (NEVER straight). Spaced en dash ( \u2013 ) NEVER em dash.
   - Footnotes end with full stops if complete sentences.
   - Dignified, reverent, scholarly tone. Non-sensational. No promotional language.
   - No "mythology" for sacred texts. No American marketing tone.
   - No modern management terms (CEO, strategy, stakeholder, roadmap, campaign, grassroots).
   - No modern psychology terms (trauma, stress, anxiety, closure, coping).
   - No motivational language. No romantic heroic exaggeration.
   - No hedging faith statements ("it seemed", "perhaps", "probably").
   - Consistent spelling, transliteration, capitalisation, hyphenation throughout.
   FORBIDDEN VOCABULARY: mythology, legendary, charismatic, revolutionary, revolutionised, progressive, humanitarian, empowerment, campaign, grassroots, stakeholder, role model, personal philosophy, compromise, flexible (for doctrine), trauma, stress, anxiety, closure, coping, reform movement, indeed, truly, remarkably, clearly, undoubtedly, milestone, legacy, network (for relationships), benchmark, innovation, productivity, work ethic, leadership style, decision-making skills, crisis management, strategic vision, vision statement, influencer, charter, public image, experimental, organisational growth, support base, negotiated, mental strength, story (for sacred events \u2014 use "incident" or "episode").

5. HISTORICAL PRECISION (10 pts) \u2014 Era-correct names (e.g. "Bombay Province" not "Mumbai"). Exact dates in British format (3 April 1781). Exact timestamps. Exact place spellings: Chhapaiya, Kathiawad, Chansad, Bamangam, Dhuliya, Dangara, Bhadrod, Piplana, Choksi. Correct attribution of historical quotes. Time-appropriate names (no later titles used prematurely). No approximation unless source approximates.

6. COMPLETENESS (5 pts) \u2014 All paragraphs translated. No summarisation. No truncation. Every verse reproduced in full. Minor details preserved (small acts reveal character). Letters translated in full (not condensed). Blessings, enumerations, repetitions preserved.

DEDUCTION RULES (per category):
- Critical violation: \u221260% of that category\u2019s weight
- Major violation: \u221240% of that category\u2019s weight
- Minor violation: \u221220% of that category\u2019s weight
- Each category score cannot go below 0

Total = sum of all 6 category scores (max 100).
Set "certifiable" to true ONLY if total >= 97 AND zero critical violations across all categories.

COMMON PITFALLS (check EVERY one):
1. saints\u2192Swamis 2. temple\u2192mandir 3. Lord Swaminarayan\u2192Bhagwan Swaminarayan
4. divine abode\u2192Akshardham 5. Shrijimaharaj\u2192Shriji Maharaj 6. penance\u2192austerities
7. haribhaktas\u2192devotees 8. indirect speech conversion 9. added commentary/judgement
10. straight quotes 11. em dash 12. macrons in prose 13. missing transliteration
14. mythology 15. aarti\u2192arti 16. vicharan\u2192vichran 17. torchbearer\u2192successor
18. place name misspellings 19. American spellings 20. fellowship\u2192satsang
21. forbidden diacritics in verse\u2192plain Roman + \u0101 only
22. straight quotes on verse lines\u2192curly quotes
23. sadhu/sadhus for impostors\u2192bawa/bawas
24. Brahmic state\u2192brahmisthiti 25. dhotiyos\u2192dhotiyas 26. Pipalana\u2192Piplana
27. recitation\u2192mukhpath 28. modern psychology terms (trauma, stress, anxiety)
29. corporate/management jargon (CEO, strategy, stakeholder, campaign)
30. hedging faith ("it seemed", "perhaps") 31. motivational language
32. romantic/heroic exaggeration 33. synonym cycling (same Gujarati word translated differently)
34. chronological rearrangement 35. Gujarati metaphors replaced with English equivalents
36. sentences split unnecessarily 37. translator commentary on miracles/faith
38. decorative adjectives added (magnificent, glorious) 39. footnotes without full stops
40. -yse/-ize confusion (analyse not analyze, organize not organise)
41. Chokshi\u2192Choksi 42. Chanasad\u2192Chansad 43. service\u2192seva (spiritual context)
44. scripture\u2192shastra (spiritual context) 45. Naran\u2019da standardisation

BAPS TRANSLATION CERTIFICATION CHECKLIST (verify ALL before certifying):
\u2610 "Shriji Maharaj" as two words | "Swami" not saint/sadhu | "mandir" not temple
\u2610 "satsang" retained (not congregation/movement/fellowship) | "Akshardham" not divine abode
\u2610 No use of mythology, legend, folk belief | No dilution of upasana
\u2610 Language is reverential, not casual | No corporate/NGO/activist vocabulary
\u2610 No emotional exaggeration or romanticisation | No hedging ("it is believed", "perhaps")
\u2610 No summarisation | No omission of incidents, dates, names, places
\u2610 No added interpretation or commentary | Sequence of events preserved
\u2610 Opposition not diluted | Violence described factually without sensationalism | No victimhood framing
\u2610 UK English with no American inconsistencies | No journalistic clich\u00e9s
\u2610 Place names verified (Chansad, Dangara, Dhuliya, Bamangam, Piplana, Choksi)
\u2610 Short forms standardised (Naran\u2019da only) | No mixed spellings
\u2610 Sanskrit shlokas preserved accurately | Citation markers retained
\u2610 "seva" not work/service | Renunciation as discipline not drama | No psychological analysis of Swamis
\u2610 Terminology matches across entire passage | No sudden tonal shifts
FINAL TEST: Would senior Swamis approve the tone? Does it preserve dignity for future generations?

COMMON PITFALL CATEGORIES (from 250+ documented corrections):
1. SECULARISATION: corporate language, treating satsang as organisation, management framing
2. WESTERN ACADEMIC BIAS: "it is believed", "according to tradition", over-contextualising
3. EMOTIONAL OVERWRITING: adding emotions not in text, psychologising, romanticising suffering
4. OVER-SIMPLIFICATION: summarising, removing intentional repetitions, flattening layered narratives
5. SYNONYM MISUSE: saint for Swami, temple for mandir, leader for Sadhu
6. INCONSISTENCY: multiple spellings, mixed short forms, changing terminology mid-text
7. MODERN VALUE PROJECTION: progressivism, humanitarian framing, reformist language
8. TRANSLATOR EGO: "improving" text, making it clever, adding interpretation
9. CULTURAL DILUTION: over-explaining, removing Indic terms, over-glossing
10. WRONG AUDIENCE: writing like academic paper, journalism, or marketing instead of sacred history

Produce a corrected revised translation fixing ALL issues found.

Return ONLY valid JSON (no fences):
{"categories": [{"id": "FIDELITY", "weight": 30, "score": 28, "deductions": ["Minor: ..."], "pass": true}, {"id": "TERMINOLOGY", "weight": 25, "score": 25, "deductions": [], "pass": true}, {"id": "VERSE_HANDLING", "weight": 15, "score": 15, "deductions": [], "pass": true}, {"id": "STYLE_REGISTER", "weight": 15, "score": 15, "deductions": [], "pass": true}, {"id": "HISTORICAL_PRECISION", "weight": 10, "score": 10, "deductions": [], "pass": true}, {"id": "COMPLETENESS", "weight": 5, "score": 5, "deductions": [], "pass": true}], "totalScore": 98, "certifiable": true, "revised": "..."}`;

const SMOOTHER_SYSTEM = `I am working on improving a translation of a non-fiction historical biography for better readability. Please revise each passage I share according to the following rules:
What to improve:
- Smooth out awkward phrasing and unnatural flow in the narrative prose
- Restructure overly long or heavily nested sentences where needed
- Use natural transitions and connective language
What to never change:
- Direct quotes from named historical figures, scholars, and writers \u2014 leave these word for word
- Transliterated verses and their translations \u2014 reproduce these in full, never truncate with ellipsis
- All proper nouns, Sanskrit/Gujarati terms, and names
- These BAPS terms (never replace with English equivalents): ${PROTECTED_TERMS}
Formatting and style:
- Use en-dash ( \u2013 ) throughout; never em-dash ( \u2014 )
- Commas and semi-colons may be used where appropriate
- British English with Oxford -ize spellings (e.g. recognize, organize, realize)
- Italicise transliterated verses and book titles

Return ONLY the revised text \u2014 no preamble, no notes.`;

const ASSEMBLER_SYSTEM = `You are a trustee of tradition (parampara) assembling a multi-chunk translation into a single publication-ready document. Your priority is fidelity: the translated chunks have already been certified against the Aksharpith House-Style Guide.

STRUCTURAL OPERATIONS ONLY:
- Remove all chunk markers, separators, and numbering
- If two adjacent chunks overlap (repeated sentences at boundaries), deduplicate
- Ensure no orphaned headings or broken paragraphs at join points
- Preserve chapter headings exactly as they appear

DO NOT:
- Rewrite, rephrase, or alter any sentence content
- Add transitional phrases not present in the chunks
- Change terminology, spelling, or punctuation
- Remove or reorder any paragraphs
- Replace these terms: ${PROTECTED_TERMS}

Formatting:
- Use en-dash ( \u2013 ) throughout; never em-dash ( \u2014 )
- Curly double speech marks (\u201c \u201d) for all quotations
- British English with Oxford -ize spellings
- Italicise transliterated verses and book titles

Output ONLY the final document \u2014 no preamble or notes.`;

// ─── Agent functions ────────────────────────────────────────────────────────

function chunkerAgent(_apiKey: string, text: string): Promise<string[]> {
  return Promise.resolve(deterministicChunk(text));
}

async function translatorAgent(
  apiKey: string, chunk: string, chunkIndex: number, totalChunks: number,
): Promise<string> {
  return callClaude({
    model: SONNET, max_tokens: 8192, apiKey,
    system: TRANSLATOR_SYSTEM,
    messages: [{ role: 'user', content: `Chunk ${chunkIndex + 1} of ${totalChunks}. Translate the following Gujarati text to English. Provide ONLY the translation.\n\nGUJARATI:\n${chunk}` }],
  });
}

interface ReviewResult {
  categories: Array<{ id: string; weight: number; score: number; deductions: string[]; pass: boolean }>;
  pitfalls: string[];
  issues: string[];
  score: number;       // mapped from totalScore for downstream compatibility
  revised: string;
  certifiable: boolean;
}

async function reviewerAgent(apiKey: string, original: string, translation: string): Promise<ReviewResult> {
  const fallback: ReviewResult = { categories: [], pitfalls: [], issues: [], score: 50, revised: translation, certifiable: false };
  let raw: string;
  try {
    raw = await callClaude({
      model: SONNET, max_tokens: 16000, apiKey,
      system: REVIEWER_SYSTEM,
      messages: [{ role: 'user', content: `GUJARATI SOURCE:\n${original}\n\nTRANSLATION TO AUDIT:\n${translation}` }],
    });
  } catch (err) {
    console.error('Reviewer API call failed:', err instanceof Error ? err.message : err);
    return fallback;
  }

  // Strip markdown code fences that LLMs often wrap JSON in
  const stripped = raw.replace(/^```(?:json)?\s*/gm, '').replace(/\s*```$/gm, '');

  // Try to extract JSON object from the response
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('Reviewer returned no JSON object. Raw response (first 500 chars):', raw.slice(0, 500));
    return fallback;
  }

  let jsonStr = match[0];

  // Attempt standard parse first
  try {
    const p = JSON.parse(jsonStr);
    // Map totalScore (weighted rubric) to score for downstream compatibility; fall back to legacy p.score
    const rawScore = typeof p.totalScore === 'number' ? p.totalScore : (typeof p.score === 'number' ? p.score : 50);
    // Normalise categories to new weighted format
    const cats: ReviewResult['categories'] = Array.isArray(p.categories)
      ? p.categories.map((c: Record<string, unknown>) => ({
          id:         typeof c.id === 'string' ? c.id : '',
          weight:     typeof c.weight === 'number' ? c.weight : 0,
          score:      typeof c.score === 'number' ? Math.max(0, c.score as number) : 0,
          deductions: Array.isArray(c.deductions) ? (c.deductions as unknown[]).filter((s: unknown) => typeof s === 'string') as string[] : (Array.isArray(c.issues) ? (c.issues as unknown[]).filter((s: unknown) => typeof s === 'string') as string[] : []),
          pass:       typeof c.pass === 'boolean' ? c.pass : true,
        }))
      : [];
    return {
      categories:  cats,
      pitfalls:    Array.isArray(p.pitfalls) ? p.pitfalls.filter((s: unknown) => typeof s === 'string') : [],
      issues:      Array.isArray(p.issues) ? p.issues.filter((s: unknown) => typeof s === 'string') : [],
      score:       Math.max(0, Math.min(100, rawScore)),
      revised:     typeof p.revised === 'string' && p.revised.trim() ? p.revised.trim() : translation,
      certifiable: typeof p.certifiable === 'boolean' ? p.certifiable : false,
    };
  } catch {
    // JSON parse failed — likely truncated response. Try to salvage what we can.
    console.error('Reviewer JSON parse failed (likely truncated). Attempting partial extraction. Raw length:', raw.length, 'First 300 chars:', raw.slice(0, 300));

    // Try to extract totalScore first (weighted rubric), fall back to score
    let score = 50;
    const totalScoreMatch = jsonStr.match(/"totalScore"\s*:\s*(\d+)/);
    if (totalScoreMatch) {
      score = Math.max(0, Math.min(100, parseInt(totalScoreMatch[1], 10)));
    } else {
      const scoreMatch = jsonStr.match(/"score"\s*:\s*(\d+)/);
      if (scoreMatch) {
        score = Math.max(0, Math.min(100, parseInt(scoreMatch[1], 10)));
      }
    }

    // Try to extract revised text (may be truncated)
    let revised = translation; // default: use original translation
    const revisedMatch = jsonStr.match(/"revised"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
    if (revisedMatch && revisedMatch[1].trim().length > 50) {
      // Only use extracted revised if it's substantial enough
      try {
        // Unescape JSON string escapes
        revised = JSON.parse(`"${revisedMatch[1]}"`);
      } catch {
        // If unescape fails, use original translation
        revised = translation;
      }
    }

    // Try to extract certifiable
    let certifiable = false;
    const certMatch = jsonStr.match(/"certifiable"\s*:\s*(true|false)/);
    if (certMatch) {
      certifiable = certMatch[1] === 'true';
    }

    // Try to extract categories
    let categories: ReviewResult['categories'] = [];
    try {
      const catMatch = jsonStr.match(/"categories"\s*:\s*\[[\s\S]*?\]/);
      if (catMatch) {
        categories = JSON.parse(catMatch[0].replace(/^"categories"\s*:\s*/, ''));
      }
    } catch { /* ignore */ }

    // Try to extract pitfalls
    let pitfalls: string[] = [];
    try {
      const pitMatch = jsonStr.match(/"pitfalls"\s*:\s*\[[\s\S]*?\]/);
      if (pitMatch) {
        pitfalls = JSON.parse(pitMatch[0].replace(/^"pitfalls"\s*:\s*/, '')).filter((s: unknown) => typeof s === 'string');
      }
    } catch { /* ignore */ }

    // Try to extract issues
    let issues: string[] = [];
    try {
      const issMatch = jsonStr.match(/"issues"\s*:\s*\[[\s\S]*?\]/);
      if (issMatch) {
        issues = JSON.parse(issMatch[0].replace(/^"issues"\s*:\s*/, '')).filter((s: unknown) => typeof s === 'string');
      }
    } catch { /* ignore */ }

    return { categories, pitfalls, issues, score, revised, certifiable };
  }
}

// Character-level diff ratio: proportion of characters that differ between two strings
function charDiffRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  let diffs = Math.abs(a.length - b.length);
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) diffs++;
  }
  return diffs / maxLen;
}

async function smootherAgent(apiKey: string, text: string): Promise<{ text: string; flagged: boolean }> {
  const smoothed = await callClaude({
    model: SONNET, max_tokens: 8192, apiKey,
    system: SMOOTHER_SYSTEM,
    messages: [{ role: 'user', content: `Perform the readability pass. Return ONLY the revised text.\n\n${text}` }],
  });
  const diffRatio = charDiffRatio(text, smoothed);
  if (diffRatio > 0.15) {
    console.warn(`Smoother changed ${(diffRatio * 100).toFixed(1)}% of characters (>15% threshold). Flagging for review and using original.`);
    return { text, flagged: true };
  }
  return { text: smoothed, flagged: false };
}

async function assemblerAgent(apiKey: string, smoothedChunks: string[]): Promise<string> {
  const combined = smoothedChunks.join('\n\n');
  if (smoothedChunks.length === 1) return combined;
  return callClaude({
    model: SONNET, max_tokens: 64000, apiKey,
    system: ASSEMBLER_SYSTEM,
    messages: [{ role: 'user', content: `Assemble these chunks into a single document:\n\n${combined}` }],
  });
}

// ─── Rules Enforcer (deterministic 6th stage) ─────────────────────────────────
// Applies every Gold Standard rule via regex. Returns the corrected text + a log
// of every correction made, so the UI can display what was fixed.

interface RulesCorrection { from: string; to: string; rule: string; count: number; }

function rulesEnforcerAgent(text: string): { text: string; corrections: RulesCorrection[]; totalFixes: number } {
  const corrections: RulesCorrection[] = [];
  let t = text;

  // Helper: apply a replacement and log it
  function apply(pattern: RegExp, replacement: string | ((m: string) => string), rule: string) {
    let count = 0;
    const before = t;
    if (typeof replacement === 'string') {
      t = t.replace(pattern, () => { count++; return replacement; });
    } else {
      t = t.replace(pattern, (m: string) => { count++; return replacement(m); });
    }
    if (count > 0) {
      // Extract a sample of what was replaced
      const sampleMatch = before.match(pattern);
      const from = sampleMatch ? sampleMatch[0] : pattern.source;
      const to = typeof replacement === 'string' ? replacement : replacement(from);
      corrections.push({ from, to, rule, count });
    }
  }

  // ═══ TERMINOLOGY RULES (from House Rules s2.1 + Examples doc) ═══
  apply(/\bsaints\b/gi, (m: string) => m[0] === 'S' ? 'Swamis' : 'swamis', 'saint(s)→Swami(s)');
  apply(/\bsaint\b/gi, (m: string) => m[0] === 'S' ? 'Swami' : 'swami', 'saint→Swami');
  apply(/\bmonks\b/gi, (m: string) => m[0] === 'M' ? 'Swamis' : 'swamis', 'monk(s)→Swami(s)');
  apply(/\bmonk\b/gi, (m: string) => m[0] === 'M' ? 'Swami' : 'swami', 'monk→Swami');
  apply(/\btemples\b/gi, (m: string) => m[0] === 'T' ? 'Mandirs' : 'mandirs', 'temple(s)→mandir(s)');
  apply(/\btemple\b/gi, (m: string) => m[0] === 'T' ? 'Mandir' : 'mandir', 'temple→mandir');
  apply(/\bharibhaktas\b/gi, 'devotees', 'haribhakta(s)→devotee(s)');
  apply(/\bharibhakta\b/gi, 'devotee', 'haribhakta→devotee');
  apply(/\bfollowers\b/gi, (m: string) => m[0] === 'F' ? 'Devotees' : 'devotees', 'follower(s)→devotee(s)');
  apply(/\bfollower\b/gi, (m: string) => m[0] === 'F' ? 'Devotee' : 'devotee', 'follower→devotee');
  apply(/\bpenance\b/gi, 'austerities', 'penance→austerities');
  apply(/\btorchbearer\b/gi, 'successor', 'torchbearer→successor');
  apply(/\baarti\b/gi, 'arti', 'aarti→arti');
  apply(/\bvicharan\b/gi, 'vichran', 'vicharan→vichran');
  apply(/\bdhotiyos\b/gi, 'dhotiyas', 'dhotiyos→dhotiyas');
  apply(/\bBrahmic state\b/gi, 'brahmisthiti', 'Brahmic state→brahmisthiti');
  apply(/\bscriptures\b/gi, (m: string) => m[0] === 'S' ? 'Shastras' : 'shastras', 'scripture(s)→shastra(s)');
  apply(/\bscripture\b/gi, (m: string) => m[0] === 'S' ? 'Shastra' : 'shastra', 'scripture→shastra');
  apply(/\bcongregation\b/gi, 'satsang', 'congregation→satsang');
  apply(/\bHindu mythology\b/gi, 'Hindu sacred history', 'Hindu mythology→Hindu sacred history');
  apply(/\bmythology\b/gi, 'sacred history', 'mythology→sacred history');
  apply(/\bLord Swaminarayan\b/g, 'Bhagwan Swaminarayan', 'Lord Swaminarayan→Bhagwan Swaminarayan');
  apply(/\bdivine abode\b/gi, 'Akshardham', 'divine abode→Akshardham');
  apply(/\bShrijimaharaj\b/g, 'Shriji Maharaj', 'Shrijimaharaj→Shriji Maharaj');
  apply(/\bShri Ji Maharaj\b/g, 'Shriji Maharaj', 'Shri Ji Maharaj→Shriji Maharaj');

  // ═══ PERSONAL NAME CORRECTIONS ═══
  apply(/\bBhilalbhai\b/g, 'Bhailalbhai', 'Bhilalbhai→Bhailalbhai');
  apply(/\bNarayanda\b/g, 'Naran\u2019da', 'Narayanda→Naran\u2019da');
  apply(/\bNaranda\b/g, 'Naran\u2019da', 'Naranda→Naran\u2019da');

  // ═══ PLACE NAME CORRECTIONS ═══
  apply(/\bPipalana\b/g, 'Piplana', 'Pipalana→Piplana');
  apply(/\bChanasad\b/g, 'Chansad', 'Chanasad→Chansad');
  apply(/\bBamangaon\b/g, 'Bamangam', 'Bamangaon→Bamangam');
  apply(/\bDholiya\b/g, 'Dhuliya', 'Dholiya→Dhuliya');
  apply(/\bDungara\b/g, 'Dangara', 'Dungara→Dangara');
  apply(/\bBhadarod\b/g, 'Bhadrod', 'Bhadarod→Bhadrod');
  apply(/\bChokshi\b/g, 'Choksi', 'Chokshi→Choksi');

  // ═══ PUNCTUATION RULES (from House Rules s1.2, s1.3) ═══
  // Straight double quotes → curly (paired)
  let openDouble = true;
  const beforeQuotes = t;
  t = t.replace(/"/g, () => { const q = openDouble ? '\u201c' : '\u201d'; openDouble = !openDouble; return q; });
  if (t !== beforeQuotes) {
    const count = (beforeQuotes.match(/"/g) || []).length;
    corrections.push({ from: '"', to: '\u201c/\u201d', rule: 'straight quotes→curly quotes', count });
  }
  // Straight single quotes → curly (paired, not apostrophes)
  const beforeSingle = t;
  t = t.replace(/'([^']{2,})'/g, '\u2018$1\u2019');
  if (t !== beforeSingle) corrections.push({ from: "'x'", to: '\u2018x\u2019', rule: 'straight single quotes→curly', count: 1 });

  // ═══ DASH RULES (from House Rules s1.2) ═══
  const beforeDash = t;
  t = t.replace(/\u2014/g, ' \u2013 ');
  t = t.replace(/ {2,}\u2013 {2,}/g, ' \u2013 ');
  if (t !== beforeDash) corrections.push({ from: '\u2014', to: ' \u2013 ', rule: 'em dash→spaced en dash', count: (beforeDash.match(/\u2014/g) || []).length });

  // ═══ DIACRITICS RULES (from House Rules s2.2) ═══
  const diacriticMap: Record<string, string> = {
    '\u1e41': 'm', '\u1e6d': 't', '\u1e63': 'sh', '\u015b': 'sh', '\u1e47': 'n',
    '\u012b': 'i', '\u016b': 'u', '\u1e5b': 'r', '\u1e45': 'n', '\u1e0d': 'd', '\u0127': 'h', '\u00f1': 'n',
  };
  for (const [from, to] of Object.entries(diacriticMap)) {
    const beforeDiac = t;
    t = t.split(from).join(to);
    if (t !== beforeDiac) {
      const count = beforeDiac.split(from).length - 1;
      corrections.push({ from, to, rule: `forbidden diacritics stripped (only \u0101 permitted)`, count });
    }
  }

  const totalFixes = corrections.reduce((s, c) => s + c.count, 0);
  return { text: t, corrections, totalFixes };
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const authUser = await verifyAuthToken(req);
  if (!authUser) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 });
  }

  const { text, chapterTitle, bookId, chapterIndex, totalChapters, bookTitle } = body as {
    text?: string; chapterTitle?: string;
    bookId?: string; chapterIndex?: number; totalChapters?: number; bookTitle?: string;
  };

  if (!text || !text.trim()) {
    return new Response(JSON.stringify({ error: 'No text provided' }), { status: 400 });
  }

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) {
    return new Response(JSON.stringify({ error: 'No text provided' }), { status: 400 });
  }
  if (wordCount > 50000) {
    return new Response(JSON.stringify({ error: `Section too long (${wordCount.toLocaleString()} words). Maximum is 50,000.` }), { status: 400 });
  }

  const apiKey: string | undefined = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500 });
  }
  const key: string = apiKey; // narrowed for use inside stream callback

  let streamClosed = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        if (streamClosed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { /* stream closed */ }
      };

      const keepaliveInterval = setInterval(() => {
        if (streamClosed) return;
        try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { /* closed */ }
      }, 10000);

      try {
        const context = chapterTitle ? ` \u2014 ${chapterTitle}` : '';

        // ── Stage 1: Chunker (deterministic) ────────────────────────────
        send({ stage: 'chunker', status: 'running' });
        const chunks = await chunkerAgent(key, text);
        if (chunks.length === 0) { send({ error: 'No content to translate' }); return; }
        send({ stage: 'chunker', status: 'done', count: chunks.length, chunks, context });

        // ── Stages 2-4: Pipelined per-chunk processing ──────────────────
        const translations: string[] = new Array(chunks.length).fill('');
        const reviews: ReviewResult[] = new Array(chunks.length);
        const smoothedChunks: string[] = new Array(chunks.length).fill('');

        // Stage completion tracking
        let translateDone = 0, reviewDone = 0, smoothDone = 0;
        let translatorStarted = false, reviewerStarted = false, smootherStarted = false;
        let translatorFinished = false, reviewerFinished = false, smootherFinished = false;
        let totalRechecks = 0;
        let smootherFlagged = 0;

        async function processChunk(i: number) {
          // ── Translate (pipelined: starts reviewing as soon as translation is done) ──
          if (!translatorStarted) { translatorStarted = true; send({ stage: 'translator', status: 'running' }); }
          translations[i] = rulesEnforcerAgent(await translatorAgent(key, chunks[i], i, chunks.length)).text;
          translateDone++;
          send({ stage: 'translator', status: 'progress', current: translateDone, total: chunks.length, index: i, translation: translations[i] });
          if (translateDone === chunks.length && !translatorFinished) {
            translatorFinished = true;
            send({ stage: 'translator', status: 'done', memorySize: 0 });
          }

          // ── Certification Review (Sonnet) — starts immediately after this chunk's translation ──
          if (!reviewerStarted) { reviewerStarted = true; send({ stage: 'reviewer', status: 'running' }); }
          reviews[i] = await reviewerAgent(key, chunks[i], translations[i]);
          send({ stage: 'reviewer', status: 'progress', completed: reviewDone + 1, total: chunks.length, index: i, categories: reviews[i].categories, pitfalls: reviews[i].pitfalls, issues: reviews[i].issues, score: reviews[i].score, certifiable: reviews[i].certifiable });

          // ── Re-review loop ──
          for (let round = 1; round <= MAX_REVIEW_ROUNDS && reviews[i].score < RECHECK_THRESHOLD; round++) {
            totalRechecks++;
            reviews[i] = await reviewerAgent(key, chunks[i], reviews[i].revised);
            send({ stage: 'reviewer', status: 'progress', completed: reviewDone, total: chunks.length, index: i, categories: reviews[i].categories, pitfalls: reviews[i].pitfalls, issues: reviews[i].issues, score: reviews[i].score, certifiable: reviews[i].certifiable, recheck: true, round });
          }

          reviewDone++;
          if (reviewDone === chunks.length && !reviewerFinished) {
            reviewerFinished = true;
            const certCount = reviews.filter(r => r.certifiable).length;
            const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;
            send({ stage: 'reviewer', status: 'done', certCount, total: chunks.length, avgScore, rechecked: totalRechecks });
          }

          // ── Smooth (run on reviewer output directly — style review folded into certification) ──
          if (!smootherStarted) { smootherStarted = true; send({ stage: 'smoother', status: 'running' }); }
          const smoothResult = await smootherAgent(key, reviews[i].revised);
          // Run rules enforcer on each chunk (terminology, punctuation, diacritics)
          const chunkEnforced = rulesEnforcerAgent(smoothResult.text);
          smoothedChunks[i] = chunkEnforced.text;
          if (smoothResult.flagged) smootherFlagged++;
          smoothDone++;
          send({ stage: 'smoother', status: 'progress', completed: smoothDone, total: chunks.length, index: i, flagged: smoothResult.flagged });
          if (smoothDone === chunks.length && !smootherFinished) {
            smootherFinished = true;
            send({ stage: 'smoother', status: 'done', flaggedChunks: smootherFlagged });
          }
        }

        // Process ALL chunks in parallel — each chunk pipelines through translate→review→smooth
        const allChunks = Array.from({ length: chunks.length }, (_, i) => i);
        await parallelBatch(allChunks, async (i) => processChunk(i), BATCH);

        // Ensure all stage-done events fire even for single-chunk case
        if (!translatorFinished) { translatorFinished = true; send({ stage: 'translator', status: 'done', memorySize: 0 }); }
        if (!reviewerFinished) {
          reviewerFinished = true;
          const certCount = reviews.filter(r => r.certifiable).length;
          const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;
          send({ stage: 'reviewer', status: 'done', certCount, total: chunks.length, avgScore, rechecked: totalRechecks });
        }
        if (!smootherFinished) {
          smootherFinished = true;
          send({ stage: 'smoother', status: 'done', flaggedChunks: smootherFlagged });
        }


        // ── Stage 5: Assembler (Sonnet) ─────────────────────────────────
        const avgScore = chunks.length > 0 ? reviews.reduce((s, r) => s + r.score, 0) / chunks.length : 0;
        send({ stage: 'assembler', status: 'running' });
        const assembled = await assemblerAgent(key, smoothedChunks);
        send({ stage: 'assembler', status: 'done' });

        // ── Stage 6: Rules Enforcer (deterministic — no LLM) ─────────────
        send({ stage: 'enforcer', status: 'running' });
        const enforced = rulesEnforcerAgent(assembled);
        const finalText = enforced.text;
        const finalWords = finalText.trim().split(/\s+/).filter(Boolean).length;
        send({
          stage: 'enforcer', status: 'done',
          output: finalText, wordCount: finalWords, avgScore: Math.round(avgScore),
          totalFixes: enforced.totalFixes,
          corrections: enforced.corrections.map(c => ({ from: c.from, to: c.to, rule: c.rule, count: c.count })),
        });

        // Save to Firestore (with error notification)
        try {
          await adminDb.collection('translations').add({
            uid: authUser.uid,
            email: authUser.email,
            chapterTitle: chapterTitle || null,
            bookId: bookId || null,
            bookTitle: bookTitle || null,
            chapterIndex: chapterIndex ?? null,
            totalChapters: totalChapters ?? null,
            inputWordCount: wordCount,
            outputWordCount: finalWords,
            avgScore: Math.round(avgScore),
            output: finalText,
            inputPreview: text.slice(0, 300),
            createdAt: new Date().toISOString(),
          });
        } catch (err: unknown) {
          console.error('Firestore save error:', err);
          send({ warning: 'Translation complete but could not save to history. Copy your output now.' });
        }

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        console.error('Pipeline error:', msg);
        send({ error: msg });
      } finally {
        clearInterval(keepaliveInterval);
        streamClosed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
