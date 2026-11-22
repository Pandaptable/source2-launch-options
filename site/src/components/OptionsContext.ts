import { createContext } from "react";
import { href } from "react-router";
import type { GameContext } from "../data/options";
import { DEFAULT_GAME } from "../games-list";

export type { GameContext } from "../data/options";

/** The game's start page */
export function gamePath(game: string): string {
  return href("/:game?", { game });
}

/** The game's list of launch options */
export function consolePath(game: string): string {
  return href("/:game/options", { game });
}

export const DeclarationsContext = createContext<GameContext>({
  game: DEFAULT_GAME,
  metadata: { generated: "" },
  consoleItems: [],
  modules: new Map(),
  error: null,
});
