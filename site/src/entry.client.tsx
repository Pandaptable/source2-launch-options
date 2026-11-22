import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { buildAllGameContexts } from "./data/options";
import { loadGameOptions } from "./data/loader";
import { GAME_LIST, type GameId } from "./games-list";

async function hydrate() {
  const loaded = new Map<GameId, Awaited<ReturnType<typeof loadGameOptions>>>();
  const errors = new Map<GameId, string>();
  await Promise.all(
    GAME_LIST.map(async (g) => {
      try {
        loaded.set(g.id, await loadGameOptions(g.id));
      } catch (e) {
        errors.set(g.id, e instanceof Error ? e.message : String(e));
      }
    }),
  );
  buildAllGameContexts(loaded, errors);

  hydrateRoot(document, <HydratedRouter />);
}

hydrate();
