export const PROTECTED_TERMS_LIST = [
  'mandir', 'seva', 'satsang', 'arti', 'vichran', 'mukhpath',
  'katha', 'kirtan', 'dharma', 'moksha', 'bhakti', 'atma',
  'maya', 'paramhansa', 'brahmisthiti', 'santmandal', 'shastra',
  'Swamishri', 'Akshardham', 'vachanamrut',
] as const;

export const PROTECTED_TERMS = PROTECTED_TERMS_LIST.join(', ');
