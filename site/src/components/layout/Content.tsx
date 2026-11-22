import { styled } from "@linaria/react";
import { getGameDef, type GameId } from "../../games-list";
import { GameIcon } from "../kind-icon/KindIcon";
import { subtleUnderline } from "../link-styles";

export const ContentWrapper = styled.main`
  padding-bottom: 24px;
  min-width: 0;

  @media (max-width: 768px) {
    grid-column: 1;
    padding-bottom: 16px;
  }
`;

export const TextMessage = styled.div`
  margin-top: 50px;
  align-self: center;
  font-size: 36px;
  color: var(--text-dim);
  text-align: center;

  @media (max-width: 768px) {
    margin-top: 20px;
    font-size: 20px;
  }
`;

export const ListItem = styled.div`
  padding: 5px 0;

  /* Cards space themselves. The list already spaces between items */
  > :last-child {
    margin-bottom: 0;
  }
`;

const PageFooter = styled.footer`
  font-size: 14px;
  color: var(--text-dim);
  text-align: center;
  padding: 8px 4px;

  a {
    color: inherit;
    ${subtleUnderline}

    &:hover {
      color: var(--text);
    }
  }
`;

/**
 * Icon and name above a group of results, like another game's. Its icon lines up with the icons
 * of the result rows below, which are inset by their card
 */
export const ResultsHeading = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 13px 4px;
  font-size: 15px;
  color: var(--text-dim);

  svg {
    border-radius: 3px;
  }
`;

/** Heading above results from another game */
export function OtherGameHeading({ gameId }: { gameId: GameId }) {
  return (
    <ResultsHeading>
      <GameIcon game={gameId} />
      {getGameDef(gameId).name}
    </ResultsHeading>
  );
}

/** Dump date, the port's origin, and the repo, at the bottom of every page */
export function SiteFooter({
  metadata,
  note,
}: {
  /** Without it, the footer leaves out the dump date */
  metadata?: { generated: string };
  note?: string;
}) {
  return (
    <PageFooter>
      {metadata?.generated && (
        <>
          {note && `${note} `}Data dumped {metadata.generated}.{" "}
        </>
      )}
      Layout ported from{" "}
      <a href="https://github.com/ValveResourceFormat/SchemaExplorer">
        ValveResourceFormat/SchemaExplorer
      </a>{" "}
      (MIT). Dumps and site source on{" "}
      <a href="https://github.com/Pandaptable/source2-launch-options">GitHub</a>.
    </PageFooter>
  );
}
