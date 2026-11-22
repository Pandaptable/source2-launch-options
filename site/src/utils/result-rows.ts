import type { ConsoleItem } from "../data/types";

/** How many similar names are listed before the rest is asked for */
export const SIMILAR_SHOWN = 50;

/** The similar names that are listed, all of them once asked for */
export function shownSimilar<T>(similar: readonly T[], showAll: boolean): readonly T[] {
  return showAll ? similar : similar.slice(0, SIMILAR_SHOWN);
}

export function consoleRowKey(item: ConsoleItem): string {
  return `${item.kind}/${item.name ?? item.hash}`;
}
