import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import type { MetaFunction } from "react-router";
import { DEFAULT_GAME, gameIdFrom, getGameDef, canonicalUrl, pageMeta } from "../games-list";
import { getGameContext } from "../data/options";
import { gamePath } from "../components/OptionsContext";
import ConsolePage from "../components/console/ConsolePage";
import { consoleCountsText, getConsoleStats } from "../utils/console-filtering";

export const meta: MetaFunction = ({ params }) => {
  const game = gameIdFrom(params.game);
  let title = "Source 2 Launch Options List";
  let description = "Lists of Source 2 launch options with their MurmurHash2 token hashes.";
  if (game) {
    const gameName = getGameDef(game).name;
    const { metadata, consoleItems } = getGameContext(game);
    title = `${gameName} Launch Options – Full List`;
    if (metadata.generated) title += ` (${metadata.generated})`;
    const counts = consoleCountsText(getConsoleStats(consoleItems));
    description = `Complete list of all ${counts} referenced by ${gameName} binaries, with their hashes and the modules that check them.`;
  }

  return pageMeta(title, description, canonicalUrl(params.game ? `${params.game}/options` : undefined));
};

export default function OptionsPage() {
  const { game: gameParam } = useParams<{ game: string }>();
  const game = gameIdFrom(gameParam) ?? DEFAULT_GAME;
  const context = getGameContext(game);
  const navigate = useNavigate();
  const valid = gameParam === game && context.consoleItems.length > 0;

  useEffect(() => {
    if (!valid) navigate(gamePath(game), { replace: true });
  }, [valid, game, navigate]);

  return <ConsolePage context={context} />;
}
