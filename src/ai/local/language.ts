/**
 * The linguistic core of the algorithmic planner.
 *
 * Pure functions only - no world access, no provider access, no I/O - so
 * understanding can be unit-tested in isolation and never drifts toward
 * "clever" behaviour that cannot be reasoned about.
 *
 * Design goal: approximate the way a person parses a short request.
 *  1. drop polite noise ("please", "can you", "for me"),
 *  2. understand number words ("twenty", "a couple") as quantities,
 *  3. tolerate typos ("folluw me" -> "follow") with bounded fuzzy matching,
 *  4. remember that "wood", "logs" and "oak log" all mean the same block.
 */
import { BLOCK_TOOL, FOODS, HOSTILE_MOB_FAMILIES, SOFT_BLOCKS } from '../../config/constants.js';
import { detectInjectedIntent } from '../../safety/chatInjectionGuard.js';

// --- normalisation ----------------------------------------------------------

/**
 * Chatty noise with zero semantic weight. Deliberately small: pronouns like
 * "me"/"here" carry meaning (they point at the requester), only pure politeness
 * is disposable.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  'please', 'thanks', 'thank', 'thx', 'pls', 'plz', 'ty',
  'just', 'okay', 'ok', 'um', 'uh', 'asap', 'immediately', 'now',
]);

/**
 * Contractions expanded before tokenising; punctuation collapses to spaces
 * except the minus sign, which stays glued to numbers ("go to 100 64 -200").
 */
const CONTRACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdon't\b/g, 'do not'],
  [/\bcan't\b/g, 'cannot'],
  [/\bwon't\b/g, 'will not'],
  [/\blet's\b/g, 'let us'],
  [/\bit's\b/g, 'it is'],
  [/\bthat's\b/g, 'that is'],
];

/** Lowercase, expand contractions, strip filler, collapse punctuation. */
export function normalize(raw: string): string {
  const minimal = normalizeMinimal(raw);
  const words = minimal.split(' ').filter((word) => word.length > 0 && !FILLER_WORDS.has(word));
  return words.join(' ');
}

/**
 * Punctuation-only normalisation: everything visible to the QA answer layer
 * and clause splitting is kept here (including politeness) so questions like
 * "thanks!" and "what do you have?" arrive whole.
 */
export function normalizeMinimal(raw: string): string {
  let text = raw.toLowerCase();
  for (const [pattern, replacement] of CONTRACTIONS) text = text.replace(pattern, replacement);
  text = text.replace(/[^a-z0-9_-]+/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

export function tokenize(normalized: string): string[] {
  return normalized.split(' ').filter((word) => word.length > 0);
}

/**
 * Words that must never be treated as a world target in vocab matching. The
 * polite-filler set above is removed by normalize(); every other word a
 * sentence legitimately contains lives here.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'me', 'my', 'myself', 'mine', 'you', 'your', 'yours', 'us', 'we', 'our',
  'it', 'its', 'that', 'them', 'they', 'these', 'those', 'this',
  'here', 'there', 'everywhere', 'somewhere', 'anywhere', 'away',
  'then', 'than', 'and', 'or', 'but', 'with', 'in', 'inside', 'into', 'from', 'out',
  'at', 'of', 'to', 'for', 'by', 'on', 'off', 'up', 'down', 'all', 'also',
  'is', 'are', 'was', 'be', 'being', 'been', 'do', 'does', 'did', 'done',
  'what', 'which', 'who', 'whose', 'when', 'where', 'why', 'how',
  'can', 'could', 'would', 'will', 'should', 'shall', 'not', 'no', 'yes',
  'a', 'i', 'have', 'got', 'hi', 'hello', 'hey', 'bye', 'ok', 'okay',
]);

// --- numbers ----------------------------------------------------------------

/** Words a player might actually say. Deliberately small and round. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

/** Multi-word quantities first encountered by children before arithmetic. */
const QUANTITY_PHRASES: ReadonlyArray<readonly [string, number]> = [
  ['a couple of', 2], ['couple of', 2], ['a couple', 2],
  ['a few', 3], ['few', 3],
  ['a handful of', 5], ['several', 5],
  ['a dozen', 12],
  ['a bunch of', 16],
  ['a lot of', 32], ['lots of', 32], ['loads of', 48],
  ['a stack of', 64], ['stack of', 64],
  ['some', 4],
];

/** "twenty five" -> 25, "-19" -> -19, "three hundred" -> 300. */
function numberRun(words: readonly string[]): number | undefined {
  if (words.length === 0 || words.length > 3) return undefined;
  if (words.length === 1) {
    const single = words[0] ?? '';
    if (/^-?\d{1,7}$/.test(single)) {
      const value = Number.parseInt(single, 10);
      return Number.isFinite(value) ? value : undefined;
    }
  }
  let sum = 0;
  for (const word of words) {
    const value = NUMBER_WORDS[word];
    if (value === undefined) return undefined;
    sum = word === 'hundred' ? (sum === 0 ? 1 : sum) * 100 : sum + value;
  }
  return sum;
}

export interface CountExtraction {
  count: number;
  /** The clause with the count words removed. */
  rest: string;
}

/**
 * Finds the first quantity in a clause and removes it. Never invents a count:
 * "mine logs" yields nothing (the caller keeps its default), "mine 20 logs"
 * becomes {count: 20, rest: "mine logs"}.
 */
export function extractCount(clause: string): CountExtraction | undefined {
  const words = tokenize(clause);
  // Multi-word quantities (longest phrases are earlier in the table).
  for (const [phrase, value] of QUANTITY_PHRASES) {
    const phraseWords = phrase.split(' ');
    for (let start = 0; start + phraseWords.length <= words.length; start++) {
      const window = words.slice(start, start + phraseWords.length);
      if (window.join(' ') !== phrase) continue;
      const rest = [...words.slice(0, start), ...words.slice(start + phraseWords.length)].join(' ');
      return { count: value, rest };
    }
  }
  // Number runs, longest first so "twenty five" beats "twenty" + orphan "five".
  for (let length = 3; length >= 1; length--) {
    for (let start = 0; start + length <= words.length; start++) {
      const run = numberRun(words.slice(start, start + length));
      if (run === undefined) continue;
      const rest = [...words.slice(0, start), ...words.slice(start + length)].join(' ');
      return { count: run, rest };
    }
  }
  return undefined;
}

// --- fuzzy matching -----------------------------------------------------------

/** Plain Levenshtein distance, early-exits once past `limit`. */
export function levenshtein(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous: number[] = new Array<number>(b.length + 1);
  let current: number[] = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0] ?? 0;
    const aChar = a[i - 1] ?? '';
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (aChar === b[j - 1] ? 0 : 1);
      const deletion = (current[j - 1] ?? 0) + 1;
      const insertion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
      rowMin = Math.min(rowMin, current[j] ?? 0);
    }
    if (rowMin > limit) return limit + 1;
    [previous, current] = [current, previous];
  }
  return previous[b.length] ?? limit + 1;
}

/** Similarity in [0, 1]; 1 means identical. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Below this similarity a typo is not assumed to be a word at all. */
export const TYPO_SIMILARITY = 0.82;

/**
 * Nearest candidate for a possibly-typo'd word. Exact matches always win, and
 * length-difference pruning keeps the cost tiny.
 */
export function fuzzyWord(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = TYPO_SIMILARITY;
  for (const candidate of candidates) {
    if (candidate === word) return candidate;
    if (Math.abs(candidate.length - word.length) > 2) continue;
    const score = similarity(candidate, word);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function wordsInOrder(words: readonly string[], phraseWords: readonly string[]): boolean {
  if (phraseWords.length > words.length) return false;
  outer: for (let i = 0; i <= words.length - phraseWords.length; i++) {
    for (let j = 0; j < phraseWords.length; j++) {
      if (words[i + j] !== phraseWords[j]) continue outer;
    }
    return true;
  }
  return false;
}

export interface PhraseMatch {
  matched: boolean;
  /** Weight: 1 = exact phrase, 0.7 = word(s) fixed as typos. */
  strength: number;
}

/**
 * Phrase detection with a typo-tolerant fallback. Multi-word phrases may have
 * every word fuzzy-corrected ("folluw mi" -> "follow me"), which wins at
 * reduced weight so exact matches still outrank them between intents.
 */
export function matchPhrase(words: readonly string[], phrase: string): PhraseMatch {
  const phraseWords = phrase.split(' ');
  if (phraseWords.length > words.length) return { matched: false, strength: 0 };
  if (wordsInOrder(words, phraseWords)) return { matched: true, strength: 1 };

  outer: for (let i = 0; i <= words.length - phraseWords.length; i++) {
    for (let j = 0; j < phraseWords.length; j++) {
      const word = words[i + j] ?? '';
      if (word === phraseWords[j]) continue;
      if (fuzzyWord(word, [phraseWords[j] ?? '']) === undefined) continue outer;
    }
    return { matched: true, strength: 0.7 };
  }
  return { matched: false, strength: 0 };
}

// --- clause splitting ---------------------------------------------------------

/**
 * Splits a request into sequential clauses ("mine wood, then build a wall").
 * Only explicit sequence markers split; a bare "and" stays inside one clause,
 * because "mine wood and stone" names two targets, not two steps.
 */
export function splitClauses(raw: string): string[] {
  return raw
    .split(/,?\s*(?:\band then\b|\bthen\b|\bafter that\b|;)\s*/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// --- safe quoting -------------------------------------------------------------

/** The only characters a quoted snippet of player text may contain. */
const SAFE_QUOTE_CHARS = /[^A-Za-z0-9 _.,!?'-]/g;

/**
 * A short, safe echo of untrusted player text.
 *
 * Untrusted text is never quoted verbatim:
 *  - text that looks like a prompt-injection attempt (or asks for secrets)
 *    is dropped entirely;
 *  - anything else is reduced to harmless characters.
 *
 * The reason is practical as well as safe: the shared validator rejects a
 * chat line that contains an injection marker, so quoting the raw text
 * would make the whole clarification message invalid and the bot would
 * answer nothing at all.
 *
 * Returns undefined when there is nothing safe left to quote.
 */
export function safeQuote(text: string, maxChars = 60): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (detectInjectedIntent(trimmed) !== null) return undefined;
  const scrubbed = trimmed.replace(SAFE_QUOTE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (scrubbed.length === 0) return undefined;
  // Scrubbing can join words into a new pattern ("ignore." -> "ignore
  // all ..."), so the scrubbed text is screened as well.
  if (detectInjectedIntent(scrubbed) !== null) return undefined;
  const clipped = scrubbed.slice(0, maxChars).trim();
  return clipped.length === 0 ? undefined : clipped;
}

// --- vocabulary ---------------------------------------------------------------

export interface VocabEntry {
  /** Minecraft id the planner emits (e.g. "oak_log"). */
  id: string;
  /** What a player may call it. */
  words: readonly string[];
  kind: 'block' | 'item' | 'food' | 'hostile';
}

const LOG_SPECIES = [
  'oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry',
] as const;

function buildVocabulary(): VocabEntry[] {
  const entries: VocabEntry[] = [];
  const add = (id: string, words: string[], kind: VocabEntry['kind']): void => {
    entries.push({ id, words, kind });
  };

  // Wood: each species by name, plus generic words that default to oak.
  for (const species of LOG_SPECIES) {
    add(`${species}_log`, [`${species} log`, `${species} wood`, species], 'block');
  }
  add('oak_log', ['log', 'logs', 'wood', 'timber'], 'block');

  add('stone', ['stone'], 'block');
  add('cobblestone', ['cobblestone', 'cobble'], 'block');
  add('dirt', ['dirt', 'soil'], 'block');
  add('sand', ['sand'], 'block');
  add('gravel', ['gravel'], 'block');
  add('clay', ['clay'], 'block');
  add('deepslate', ['deepslate', 'deep slate'], 'block');
  add('netherrack', ['netherrack', 'nether rack'], 'block');
  add('obsidian', ['obsidian'], 'block');
  add('glass', ['glass'], 'block');
  add('torch', ['torch', 'torches'], 'item');
  add('iron_sword', ['sword', 'swords', 'iron sword', 'iron swords', 'irons'], 'item');
  add('iron_pickaxe', ['pickaxe', 'pick', 'pickaxes', 'picks'], 'item');
  add('iron_axe', ['axe', 'axes', 'hatchet'], 'item');
  add('iron_shovel', ['shovel', 'spade', 'shovels'], 'item');
  add('bow', ['bow', 'bows'], 'item');
  add('arrow', ['arrow', 'arrows'], 'item');

  add('iron_ore', ['iron ore', 'iron'], 'block');
  add('gold_ore', ['gold ore', 'gold'], 'block');
  add('coal_ore', ['coal ore', 'coal'], 'block');
  add('diamond_ore', ['diamond ore', 'diamonds'], 'block');
  add('redstone_ore', ['redstone ore', 'redstone'], 'block');
  add('lapis_ore', ['lapis ore', 'lapis'], 'block');
  add('copper_ore', ['copper ore', 'copper'], 'block');
  add('emerald_ore', ['emerald ore', 'emeralds'], 'block');

  for (const food of FOODS) {
    const pretty = food.replace(/_/g, ' ');
    add(food, [pretty], 'food');
  }
  // Friendly words players actually use for food.
  add('cooked_beef', ['steak', 'beef'], 'food');
  add('cooked_porkchop', ['porkchop', 'pork'], 'food');
  add('cooked_chicken', ['chicken'], 'food');
  add('cooked_mutton', ['mutton'], 'food');
  add('cooked_salmon', ['salmon', 'fish'], 'food');
  add('baked_potato', ['potato'], 'food');
  add('melon_slice', ['melon'], 'food');
  add('sweet_berries', ['berries'], 'food');
  add('bread', ['bread'], 'food');
  add('apple', ['apple', 'apples'], 'food');

  for (const mob of HOSTILE_MOB_FAMILIES) {
    if (mob.includes('_')) continue; // "cave spider" phrases get fuzzy-matched via id anyway.
    add(mob, [mob, `${mob}s`], 'hostile');
  }
  add('cave_spider', ['cave spider', 'cave spiders'], 'hostile');
  add('wither_skeleton', ['wither skeleton', 'wither skeletons'], 'hostile');
  add('piglin_brute', ['brute'], 'hostile');
  add('zombie_villager', ['zombie villager'], 'hostile');

  return entries;
}

export const VOCAB: ReadonlyArray<VocabEntry> = buildVocabulary();

export interface VocabMatch {
  entry: VocabEntry;
  /** 1 = exact synonym, 0.8 = exact id, 0.65 = typo-corrected. */
  strength: number;
}

/**
 * vocabulary lookup for one word: exact synonyms, then the id itself, then one
 * fuzzy pass. Exact matches sort above fuzzy ones; ties keep table order.
 */
export function findVocabEntries(word: string): VocabMatch[] {
  if (word.length < 3 || STOP_WORDS.has(word)) return [];
  const hits: VocabMatch[] = [];
  for (const entry of VOCAB) {
    if (entry.id === word) {
      hits.push({ entry, strength: 0.8 });
      continue;
    }
    for (const synonym of entry.words) {
      if (synonym === word) {
        hits.push({ entry, strength: 1 });
        break;
      }
    }
  }
  if (hits.length === 0) {
    // Fuzzy pass: strength reflects the actual similarity, so "swords" (a
    // near-exact plural of "sword") ranks far above a distant word.
    const candidates = [...VOCAB.flatMap((entry) => entry.words), ...VOCAB.map((entry) => entry.id)];
    const corrected = fuzzyWord(word, candidates);
    if (corrected === undefined) return hits;
    const score = similarity(corrected, word);
    for (const entry of VOCAB) {
      if (entry.words.includes(corrected) || entry.id === corrected) {
        hits.push({ entry, strength: 0.5 + 0.45 * score });
      }
    }
  }
  return hits.sort((a, b) => b.strength - a.strength);
}

/** Preferred tool for a block from constants ("pickaxe" for iron_ore). */
export function requiredTool(blockId: string): string | undefined {
  return BLOCK_TOOL[blockId]?.[0];
}

/** True when the block is normally hand-mined (used for helpful tips). */
export function isSoftBlock(id: string): boolean {
  return SOFT_BLOCKS.has(id);
}
