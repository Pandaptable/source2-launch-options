export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** "1 option", "2 options" */
export function plural(n: number, word: string): string {
  return `${formatCount(n)} ${word}${n !== 1 ? "s" : ""}`;
}
