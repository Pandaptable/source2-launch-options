import type { ConsoleItem } from "../data/types";
import { countBy } from "./collections";
import { formatCount } from "./format";
import { mergeRanges } from "./highlight";
import {
  combineMatches,
  isBetterMatch,
  joinedWordForms,
  matchTypoWords,
  scoreName,
  TIER_EXACT,
  TIER_FUZZY,
  TYPO_MAX_RESULTS,
  TYPO_SCORE_BASE,
  typoMatch,
  type NameMatch,
} from "./match-score";
import { joinLoneTags, trimNameWord } from "./search-words";

export type ConsoleKind = "all" | "convars" | "commands" | "values" | "unmapped";

/** Tags that have filter chips */
export type FilterTag = "module:" | "type:" | "flag:";

export type TagState = "off" | "include" | "exclude";

/** The string an item is searched by: its token, or the hash when only that is known */
function optionName(item: ConsoleItem): string {
  return item.name ?? String(item.hash);
}

/** The match of a search whose every word is the item's hash, or a decimal prefix of it */
function matchHashWords(words: readonly string[], item: ConsoleItem): NameMatch | null {
  const dec = String(item.hash);
  let matched = false;
  for (const word of words) {
    if (word === dec || (/^\d+$/.test(word) && dec.startsWith(word))) {
      matched = true;
    } else {
      return null;
    }
  }
  return matched ? { tier: TIER_EXACT, score: 0, ranges: [] } : null;
}

export interface ParsedConsoleSearch {
  nameWords: string[];
  modules: string[];
  notModules: string[];
  types: string[];
  notTypes: string[];
  flags: string[];
  notFlags: string[];
}

const CONSOLE_TAGS = ["module:", "type:", "flag:"] as const;

export function isConsoleFilterWord(word: string): boolean {
  const w = word.startsWith("-") ? word.slice(1) : word;
  return CONSOLE_TAGS.some((t) => w.startsWith(t));
}

/** Whether a word is a tag with no value, like "flag:" or "-flag:" */
export function isLoneConsoleTag(word: string): boolean {
  const w = word.startsWith("-") ? word.slice(1) : word;
  return (CONSOLE_TAGS as readonly string[]).includes(w);
}

/** A name word without the punctuation around it, a leading + or - of a command name kept */
function trimConsoleNameWord(word: string): string {
  const sign = word.startsWith("+") || word.startsWith("-") ? word[0] : "";
  const trimmed = trimNameWord(word.slice(sign.length));
  return trimmed === "" ? "" : sign + trimmed;
}

export function parseConsoleSearch(search: string): ParsedConsoleSearch {
  const parsed: ParsedConsoleSearch = {
    nameWords: [],
    modules: [],
    notModules: [],
    types: [],
    notTypes: [],
    flags: [],
    notFlags: [],
  };

  const split = search.toLowerCase().split(/\s+/);
  for (const word of joinLoneTags(split, isLoneConsoleTag, isConsoleFilterWord)) {
    if (!word) continue;
    const negated = word.startsWith("-") && isConsoleFilterWord(word);
    const w = negated ? word.slice(1) : word;
    const colon = w.indexOf(":");
    const tag = colon >= 0 ? w.slice(0, colon + 1) : "";
    const value = w.slice(colon + 1);

    if (tag === "module:") {
      const list = negated ? parsed.notModules : parsed.modules;
      if (value) list.push(value);
    } else if (tag === "type:") {
      const list = negated ? parsed.notTypes : parsed.types;
      if (value) list.push(value);
    } else if (tag === "flag:") {
      const list = negated ? parsed.notFlags : parsed.flags;
      if (value) list.push(value);
    } else {
      const nameWord = trimConsoleNameWord(word);
      if (nameWord) parsed.nameWords.push(nameWord);
    }
  }

  return parsed;
}

/** Keys most used first, then by name */
function keysByCount(counts: Map<string, number>): string[] {
  return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : 1));
}

/** The boolean properties of an option, each filterable as flag:<name> */
export const FLAGS: Record<string, { label: string; tip: string }> = {
  locked: {
    label: "Lock-gated",
    tip: "Every check of this option is lock-gated: it only answers when the process is launched with -tools, -dedicated or -insecure",
  },
  shared: { label: "Also in other games", tip: "Other games' binaries check this token too" },
  needs: {
    label: "Some checks need others",
    tip: "At least one check of this option only counts when another launch option is present too",
  },
  alias: {
    label: "Some checks accept others",
    tip: "At least one check of this option also counts when another launch option stands in for it",
  },
};

/** The flags an option has */
export function itemFlags(item: ConsoleItem): string[] {
  const flags: string[] = [];
  if (item.locked) flags.push("locked");
  if (item.elsewhere?.length) flags.push("shared");
  if (item.needs?.length) flags.push("needs");
  if (item.or?.length) flags.push("alias");
  return flags;
}

/** Every module, value type and flag with its item count, and the keys most used first */
export interface ConsoleStats {
  modules: Map<string, number>;
  types: Map<string, number>;
  flags: Map<string, number>;
  sorted: { modules: string[]; types: string[]; flags: string[] };
  /** "-" flags */
  convars: number;
  /** "+" commands */
  commands: number;
  /** Hashes whose token is unknown */
  unmapped: number;
}

const statsCache = new WeakMap<ConsoleItem[], ConsoleStats>();

/** The value types an item reads, ["value"] when only the fact is known */
export function itemTypes(item: ConsoleItem): string[] {
  return item.valueTypes ?? (item.value ? ["value"] : []);
}

/** Cached per game. The app builds the item list once when it loads the schemas */
export function getConsoleStats(items: ConsoleItem[]): ConsoleStats {
  let stats = statsCache.get(items);
  if (stats) return stats;

  const convars = items.filter((i) => i.kind === "convar").length;
  const commands = items.filter((i) => i.kind === "command").length;
  const modules = countBy(items, (i) => i.modules);
  const types = countBy(items, itemTypes);
  const flags = countBy(items, itemFlags);
  stats = {
    modules,
    types,
    flags,
    sorted: {
      modules: keysByCount(modules),
      types: keysByCount(types),
      flags: keysByCount(flags),
    },
    convars,
    commands,
    unmapped: items.length - convars - commands,
  };
  statsCache.set(items, stats);

  return stats;
}

/** "633 launch options" */
export function consoleCountsText(stats: ConsoleStats): string {
  return `${formatCount(stats.convars + stats.commands + stats.unmapped)} launch options`;
}

type Predicate = (value: string) => boolean;

/**
 * A tag value that is a known name matches exactly, so module:client does not match
 * panoramauiclient. Any other value matches as a substring while it is still being typed
 */
function valuePredicates(values: string[], known: Map<string, number>): Predicate[] {
  return values.map((v): Predicate => (known.has(v) ? (x) => x === v : (x) => x.includes(v)));
}

/**
 * module: (any of) and -module: (none of), or null without module filters. A disabled module only
 * takes an option away when none of its other modules passes the filters as well
 */
export function moduleFilter(
  parsed: ParsedConsoleSearch,
  stats: ConsoleStats,
): ((item: ConsoleItem) => boolean) | null {
  const include = valuePredicates(parsed.modules, stats.modules);
  const exclude = valuePredicates(parsed.notModules, stats.modules);
  if (include.length === 0 && exclude.length === 0) return null;
  return (item) =>
    item.modules.some(
      (m) => (include.length === 0 || include.some((p) => p(m))) && !exclude.some((p) => p(m)),
    );
}

/** type: (any of the item's value types) and -type: (none of them), or null without type filters */
export function typeFilter(
  parsed: ParsedConsoleSearch,
  stats: ConsoleStats,
): ((item: ConsoleItem) => boolean) | null {
  const include = valuePredicates(parsed.types, stats.types);
  const exclude = valuePredicates(parsed.notTypes, stats.types);
  if (include.length === 0 && exclude.length === 0) return null;
  return (item) => {
    const types = itemTypes(item);
    return (
      (include.length === 0 || types.some((t) => include.some((p) => p(t)))) &&
      !types.some((t) => exclude.some((p) => p(t)))
    );
  };
}

/** flag: (every one of them) and -flag: (none of them), or null without flag filters */
export function flagFilter(
  parsed: ParsedConsoleSearch,
  stats: ConsoleStats,
): ((item: ConsoleItem) => boolean) | null {
  const include = valuePredicates(parsed.flags, stats.flags);
  const exclude = valuePredicates(parsed.notFlags, stats.flags);
  if (include.length === 0 && exclude.length === 0) return null;
  return (item) => {
    const flags = itemFlags(item);
    return include.every((p) => flags.some(p)) && !flags.some((f) => exclude.some((p) => p(f)));
  };
}

/** The same search with one flag's include and exclude lifted, to count that flag */
export function withoutFlag(parsed: ParsedConsoleSearch, flag: string): ParsedConsoleSearch {
  if (!parsed.flags.includes(flag) && !parsed.notFlags.includes(flag)) return parsed;
  return {
    ...parsed,
    flags: parsed.flags.filter((f) => f !== flag),
    notFlags: parsed.notFlags.filter((f) => f !== flag),
  };
}

/** Whether the search has any module:, type: or flag: tag */
export function hasTagFilters(parsed: ParsedConsoleSearch): boolean {
  return (
    parsed.modules.length +
    parsed.notModules.length +
    parsed.types.length +
    parsed.notTypes.length +
    parsed.flags.length +
    parsed.notFlags.length >
    0
  );
}

/** An item a search found, the item itself kept as it is */
export interface ConsoleMatch {
  item: ConsoleItem;
  /** How well the name matches the search, a TIER_ constant. TIER_EXACT without name words */
  tier: number;
  /** The matched parts of the name, to highlight. Missing without name words */
  nameRanges?: readonly number[];
}

/** The matches of the words of a name as one: their worst tier, summed score and merged ranges */
function combinedMatch(matches: readonly NameMatch[]): NameMatch {
  const { tier, score } = combineMatches(matches);
  return { tier, score, ranges: mergeRanges(matches.map((m) => m.ranges)) };
}

/**
 * The better of `best` and the words joined in the ways a space can stand for. A space often
 * stands for an underscore or nothing, so "cl color" also matches cl_color exactly
 */
function betterJoined(
  words: readonly string[],
  name: string,
  lower: string,
  best: NameMatch | null,
  fuzzy: boolean,
): NameMatch | null {
  let better = best;
  for (const form of joinedWordForms(words)) {
    const joined = scoreName(form, name, lower, fuzzy);
    if (joined !== null && isBetterMatch(joined, better)) better = joined;
  }
  return better;
}

/**
 * How a name matches every word of the search, or null when a word is missing from it. The tier
 * is the worst of the words'
 */
function matchWords(words: readonly string[], name: string): NameMatch | null {
  const lower = name.toLowerCase();
  const matches: NameMatch[] = [];
  for (const word of words) {
    const match = scoreName(word, name, lower, true);
    if (match === null) return null;
    matches.push(match);
  }

  const best = combinedMatch(matches);
  if (words.length === 1 || best.tier === TIER_EXACT) return best;
  return betterJoined(words, name, lower, best, true);
}

/**
 * The match of a name when some word doesn't match as it is. Only the joined words can still
 * make the name a result, and only when every word at least matches fuzzily
 */
function matchJoinedWords(words: readonly string[], name: string, lower: string): NameMatch | null {
  const joined = betterJoined(words, name, lower, null, false);
  if (joined === null) return null;

  for (const word of words) {
    if (scoreName(word, name, lower, true) === null) return null;
  }
  return joined;
}

/**
 * The match of a name that is a result, or null. It equals the match of matchWords unless that
 * match is fuzzy. It does not look for fuzzy matches of words that match as they are
 */
function matchResultWords(words: readonly string[], name: string): NameMatch | null {
  const lower = name.toLowerCase();
  const matches: NameMatch[] = [];
  for (const word of words) {
    const match = scoreName(word, name, lower, false);
    if (match === null) {
      if (words.length === 1) return null;
      return matchJoinedWords(words, name, lower);
    }
    matches.push(match);
  }

  const best = combinedMatch(matches);
  if (words.length === 1 || best.tier === TIER_EXACT) return best;
  return betterJoined(words, name, lower, best, false);
}

/** A name and the name in lowercase, which a word is scored against */
interface NameTarget {
  name: string;
  lower: string;
}

function scoreTargetWord(word: string, target: NameTarget): NameMatch | null {
  return scoreName(word, target.name, target.lower, false);
}

function typoTargetWord(word: string, target: NameTarget): NameMatch | null {
  return typoMatch(word, target.name, target.lower);
}

/**
 * The match when every word is in the name and at least one word is a typo of a word of the
 * name. Null without a typo, because the words already find or miss such a name
 */
function matchTypoName(words: readonly string[], name: string): NameMatch | null {
  const target = { name, lower: name.toLowerCase() };
  const matches = matchTypoWords(words, target, scoreTargetWord, typoTargetWord);
  if (matches === null) return null;
  return {
    tier: TIER_FUZZY,
    score: TYPO_SCORE_BASE + name.length,
    ranges: mergeRanges(matches.map((m) => m.ranges)),
  };
}

export interface ConsoleFilterOptions {
  kind?: ConsoleKind;
  /** Skip module:/-module: filters, for per-module chip counts */
  ignoreModules?: boolean;
  /** Skip type:/-type: filters, for per-type chip counts */
  ignoreTypes?: boolean;
}

/** The items that pass every filter of the search but its name words, in item order */
function filterByTags(
  items: ConsoleItem[],
  parsed: ParsedConsoleSearch,
  { kind = "all", ignoreModules = false, ignoreTypes = false }: ConsoleFilterOptions,
): ConsoleItem[] {
  const stats = getConsoleStats(items);
  const matchesModules = ignoreModules ? null : moduleFilter(parsed, stats);
  const matchesTypes = ignoreTypes ? null : typeFilter(parsed, stats);
  const matchesFlags = flagFilter(parsed, stats);

  const tagged: ConsoleItem[] = [];
  for (const item of items) {
    if (kind === "convars" && item.kind !== "convar") continue;
    if (kind === "commands" && item.kind !== "command") continue;
    if (matchesModules && !matchesModules(item)) continue;
    if (matchesTypes && !matchesTypes(item)) continue;
    if (matchesFlags && !matchesFlags(item)) continue;
    tagged.push(item);
  }
  return tagged;
}

/**
 * The items a search lists as results, in item order. Items that only match by name fuzzily are
 * not results. Nothing is ranked or highlighted. This function is for counting
 */
export function filterConsoleItems(
  items: ConsoleItem[],
  parsed: ParsedConsoleSearch,
  options: ConsoleFilterOptions = {},
): ConsoleItem[] {
  const tagged = filterByTags(items, parsed, options);
  const { nameWords } = parsed;
  if (nameWords.length === 0) return tagged;

  const found: ConsoleItem[] = [];
  for (const item of tagged) {
    if (
      matchResultWords(nameWords, optionName(item)) !== null ||
      matchHashWords(nameWords, item) !== null
    ) {
      found.push(item);
    }
  }
  return found;
}

export interface ConsoleSearchResults {
  /** The items that match the search, best name first */
  results: ConsoleMatch[];
  /** The items that only match by name fuzzily, which are not results. None without name words */
  similar: ConsoleMatch[];
}

interface ScoredItem {
  item: ConsoleItem;
  match: NameMatch;
}

function rankMatches(scored: ScoredItem[]): ConsoleMatch[] {
  scored.sort((a, b) => a.match.tier - b.match.tier || a.match.score - b.match.score);
  return scored.map(({ item, match }) => ({ item, tier: match.tier, nameRanges: match.ranges }));
}

/**
 * The results of a search, best name first. They equal the results of searchConsoleItems, but this
 * function does not look for similar names
 */
export function searchConsoleResults(
  items: ConsoleItem[],
  parsed: ParsedConsoleSearch,
  options: ConsoleFilterOptions = {},
): ConsoleMatch[] {
  const tagged = filterByTags(items, parsed, options);
  const { nameWords } = parsed;
  if (nameWords.length === 0) return tagged.map((item) => ({ item, tier: TIER_EXACT }));

  const found: ScoredItem[] = [];
  for (const item of tagged) {
    const match = matchResultWords(nameWords, optionName(item)) ?? matchHashWords(nameWords, item);
    if (match !== null) found.push({ item, match });
  }
  return rankMatches(found);
}

/** The results of a search and, apart from them, the similar names, found in one pass */
export function searchConsoleItems(
  items: ConsoleItem[],
  parsed: ParsedConsoleSearch,
  options: ConsoleFilterOptions = {},
): ConsoleSearchResults {
  const tagged = filterByTags(items, parsed, options);
  const { nameWords } = parsed;
  if (nameWords.length === 0) {
    const results = tagged.map((item) => ({ item, tier: TIER_EXACT }));
    return { results, similar: [] };
  }

  const found: ScoredItem[] = [];
  let fuzzy: ScoredItem[] = [];
  const unmatched: ConsoleItem[] = [];
  for (const item of tagged) {
    const match = matchWords(nameWords, optionName(item)) ?? matchHashWords(nameWords, item);
    if (match === null) {
      unmatched.push(item);
    } else if (match.tier === TIER_FUZZY) {
      fuzzy.push({ item, match });
      unmatched.push(item);
    } else {
      found.push({ item, match });
    }
  }

  if (found.length < TYPO_MAX_RESULTS) {
    const typos: ScoredItem[] = [];
    const typoItems = new Set<ConsoleItem>();
    for (const item of unmatched) {
      const match = matchTypoName(nameWords, optionName(item));
      if (match === null) continue;
      typos.push({ item, match });
      typoItems.add(item);
    }
    if (typos.length > 0) fuzzy = [...typos, ...fuzzy.filter((x) => !typoItems.has(x.item))];
  }

  return { results: rankMatches(found), similar: rankMatches(fuzzy) };
}

/** Adds, removes or negates a tag:value word in a search string */
export function setSearchTag(search: string, tag: string, value: string, state: TagState): string {
  const lowerValue = value.toLowerCase();
  const words = joinLoneTags(search.split(/\s+/), isLoneConsoleTag, isConsoleFilterWord)
    .filter((w) => {
      const lower = w.toLowerCase();
      return lower !== `${tag}${lowerValue}` && lower !== `-${tag}${lowerValue}`;
    })
    .filter(Boolean);

  if (state === "include") {
    words.push(`${tag}${value}`);
  } else if (state === "exclude") {
    words.push(`-${tag}${value}`);
  }

  return words.join(" ");
}

/** Removes every module:, flag: and type: tag, keeping the name words */
export function stripConsoleFilters(search: string): string {
  const words = joinLoneTags(search.split(/\s+/), isLoneConsoleTag, isConsoleFilterWord);
  return words.filter((w) => w && !isConsoleFilterWord(w.toLowerCase())).join(" ");
}

const TAG_LISTS = {
  "module:": ["modules", "notModules"],
  "type:": ["types", "notTypes"],
  "flag:": ["flags", "notFlags"],
} as const;

export function getTagState(parsed: ParsedConsoleSearch, tag: FilterTag, value: string): TagState {
  const lower = value.toLowerCase();
  const [included, excluded] = TAG_LISTS[tag];
  if (parsed[included].includes(lower)) return "include";
  if (parsed[excluded].includes(lower)) return "exclude";
  return "off";
}

// Every chip cycles off → include → exclude
const NEXT_TAG_STATE: Record<FilterTag, Record<TagState, TagState>> = {
  "flag:": { off: "include", include: "exclude", exclude: "off" },
  "module:": { off: "include", include: "exclude", exclude: "off" },
  "type:": { off: "include", include: "exclude", exclude: "off" },
};

export function nextTagState(tag: FilterTag, state: TagState): TagState {
  return NEXT_TAG_STATE[tag][state];
}
