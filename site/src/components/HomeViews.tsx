import type { ReactNode } from "react";
import type { GameId } from "../games-list";
import { getGameDef } from "../games-list";
import { PageHeader, PageTitle } from "./styles";
import { OptionChecker } from "./OptionChecker";

export function RootHome(): ReactNode {
  return (
    <>
      <PageHeader>
        <PageTitle>Source 2 Launch Options</PageTitle>
      </PageHeader>
      <OptionChecker />
    </>
  );
}

export function GameHome({ game }: { game: GameId }): ReactNode {
  return (
    <>
      <PageHeader>
        <PageTitle>{getGameDef(game).name} Launch Options</PageTitle>
      </PageHeader>
      <OptionChecker />
    </>
  );
}
