import { useParams } from "react-router";
import type { MetaFunction } from "react-router";
import {
  DEFAULT_GAME,
  SITE_NAME,
  canonicalUrl,
  gameIdFrom,
  getGameDef,
  pageMeta,
} from "../games-list";
import { getGameContext } from "../data/options";
import { PageProviders, PageShell } from "../components/layout/PageShell";
import { ContentWrapper, SiteFooter } from "../components/layout/Content";
import { GameHome, RootHome } from "../components/HomeViews";

export const meta: MetaFunction = ({ params }) => {
  const game = gameIdFrom(params.game);
  if (!game) {
    return pageMeta(
      SITE_NAME,
      "Launch options of CS2, Dota 2 and Deadlock with their MurmurHash2 token hashes.",
      canonicalUrl(),
    );
  }
  const gameName = getGameDef(game).name;
  return pageMeta(
    `${gameName} - ${SITE_NAME}`,
    `Launch options referenced by ${gameName} binaries.`,
    canonicalUrl(game),
  );
};

export default function HomePage() {
  const { game: gameParam } = useParams<{ game: string }>();
  const game = gameIdFrom(gameParam);
  const context = getGameContext(game ?? DEFAULT_GAME);

  return (
    <PageProviders context={context}>
      <PageShell sidebar={() => null}>
        <ContentWrapper>
          {game ? <GameHome game={game} /> : <RootHome />}
          <SiteFooter metadata={context.metadata} />
        </ContentWrapper>
      </PageShell>
    </PageProviders>
  );
}
