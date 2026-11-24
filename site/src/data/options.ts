import { GAME_LIST, type GameId } from "../games-list";
import type { ConsoleItem, ModuleInfo, OptionsJson } from "./types";

export interface GameContext {
  game: GameId;
  metadata: { generated: string };
  /** Every launch option of the game, sorted by name */
  consoleItems: ConsoleItem[];
  modules: Map<string, ModuleInfo>;
  error: string | null;
}

/** The token's kind from its prefix: "-" flags, "+" commands */
function kindOf(name: string | null): ConsoleItem["kind"] {
  if (name == null) return "unmapped";
  if (name.startsWith("-")) return "convar";
  if (name.startsWith("+")) return "command";
  return "convar";
}

export interface ParsedOptions {
  metadata: { generated: string };
  consoleItems: ConsoleItem[];
  modules: Map<string, ModuleInfo>;
}

export function parseOptions(data: OptionsJson): ParsedOptions {
  const modules = new Map<string, ModuleInfo>(
    data.modules.map((m) => [m.name, { name: m.name, path: m.path, imports: m.imports, dynamic: m.dynamic }]),
  );
  const consoleItems: ConsoleItem[] = data.options.map((o) => ({
    kind: kindOf(o.name),
    name: o.name,
    hash: o.hash,
    modules: o.modules,
    value: o.value,
    valueTypes: o.valueTypes,
    locked: o.locked,
    needs: o.needs,
    or: o.or,
    alternatives: o.alternatives,
    sites: o.sites,
  }));
  consoleItems.sort((a, b) => ((a.name ?? String(a.hash)) < (b.name ?? String(b.hash)) ? -1 : 1));
  return { metadata: { generated: data.generated }, consoleItems, modules };
}

const contexts = new Map<GameId, GameContext>();

/**
 * The parsed data of every game, cached for the app's lifetime. After
 * caching, each named option learns which other games also check it
 */
export function buildAllGameContexts(loaded: Map<GameId, ParsedOptions>, errors: Map<GameId, string>): void {
  const namesByGame = new Map<GameId, Set<string>>();
  for (const game of GAME_LIST) {
    const data = loaded.get(game.id);
    const items = data?.consoleItems ?? [];
    namesByGame.set(
      game.id,
      new Set(items.flatMap((item) => (item.name ? [item.name] : []))),
    );
  }

  for (const game of GAME_LIST) {
    const data = loaded.get(game.id);
    if (data) {
      for (const item of data.consoleItems) {
        if (item.name == null) continue;
        const elsewhere = GAME_LIST.filter(
          (g) => g.id !== game.id && namesByGame.get(g.id)?.has(item.name!),
        ).map((g) => g.id);
        if (elsewhere.length > 0) item.elsewhere = elsewhere;
      }
    }
    contexts.set(
      game.id,
      data
        ? { game: game.id, ...data, error: errors.get(game.id) ?? null }
        : {
          game: game.id,
          metadata: { generated: "" },
          consoleItems: [],
          modules: new Map(),
          error: errors.get(game.id) ?? "not loaded",
        },
    );
  }
}

export function getGameContext(id: GameId): GameContext {
  return contexts.get(id)!;
}
