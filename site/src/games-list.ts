const GAMES = [
  {
    id: "cs2",
    name: "Counter-Strike 2",
    shortName: "CS2",
  },
  {
    id: "dota2",
    name: "Dota 2",
    shortName: "Dota 2",
  },
  {
    id: "deadlock",
    name: "Deadlock",
    shortName: "Deadlock",
  },
] as const;

export type GameId = (typeof GAMES)[number]["id"];

interface GameDef {
  id: GameId;
  name: string;
  /** For page titles, where the full name takes too much room */
  shortName: string;
}

export const ALL_GAMES: readonly GameDef[] = GAMES;
export const GAME_LIST: readonly GameDef[] = ALL_GAMES;
export const DEFAULT_GAME: GameId = GAME_LIST[0].id;

const gamesById = new Map<GameId, GameDef>();
for (const game of ALL_GAMES) {
  gamesById.set(game.id, game);
}

export function getGameDef(id: GameId): GameDef {
  return gamesById.get(id)!;
}

export function isGameId(id: string): id is GameId {
  return GAME_LIST.some((g) => g.id === id);
}

/**
 * A dump file this repo generated, or the game's hashes/ directory when the path is empty.
 * The tracked directory is linked, which for deadlock is the merged "deadlock" one
 */
export function dumpFileUrl(id: string, path: string): string | null {
  if (!isGameId(id)) return null;
  const where = path ? `blob/main/hashes/${id}/${path}` : `tree/main/hashes/${id}`;
  return `https://github.com/Pandaptable/source2-launch-options/${where}`;
}

/** The game id in a URL parameter, or null when it is missing or unknown */
export function gameIdFrom(value: string | undefined): GameId | null {
  if (value && isGameId(value)) return value;
  return null;
}

export const SITE_NAME = "Source 2 Launch Options";
export const SITE_ORIGIN = "https://hashes.pandaptable.moe";

export function canonicalUrl(game?: string) {
  return `${SITE_ORIGIN}/${game ?? ""}`;
}

/** Title, description, Open Graph and canonical tags of a page */
export function pageMeta(title: string, description: string, url: string) {
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { tagName: "link", rel: "canonical", href: url },
  ];
}
