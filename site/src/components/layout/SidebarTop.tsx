import { useContext, type ReactNode } from "react";
import { styled } from "@linaria/react";
import { useLocation } from "react-router";
import { GAME_LIST } from "../../games-list";
import { AppContext } from "../AppContext";
import { GameIcon, SpriteIcon, UiIcon } from "../kind-icon/KindIcon";
import { Link } from "../Link";
import { DeclarationsContext, consolePath } from "../OptionsContext";
import { SearchContext } from "../search/SearchContext";
import { currentRow, iconButton, sidebarRow } from "./sidebar-styles";

/**
 * Brand, then where you are: the game, each a list of rows. The page's own
 * list follows below it
 */
export function SidebarTop({
  onNavigate,
  sidebarOpen,
  show,
}: {
  /** Closes the mobile drawer */
  onNavigate: () => void;
  sidebarOpen: boolean;
  /** The page's filters of what its list shows, a ShowGroup */
  show?: ReactNode;
}) {
  return (
    <Top>
      <BrandRow>
        <Brand href="/">
          <SpriteIcon id="nem-logo" size={28} />
          <span>Source 2 Launch Options</span>
        </Brand>
        <ThemeButton />
        {sidebarOpen && (
          <IconButton onClick={onNavigate} aria-label="Close sidebar">
            <UiIcon name="close" />
          </IconButton>
        )}
      </BrandRow>
      <GameRows onNavigate={onNavigate} />
      {show}
    </Top>
  );
}

function ThemeButton() {
  const { darkmode, setDarkmode } = useContext(AppContext);

  return (
    <ThemeToggle
      onClick={() => setDarkmode(!darkmode)}
      title={darkmode ? "Switch to light theme" : "Switch to dark theme"}
      aria-label="Toggle dark theme"
    >
      <UiIcon className="moon" name="moon" />
      <UiIcon className="sun" name="sun" />
    </ThemeToggle>
  );
}

function GameRows({ onNavigate }: { onNavigate: () => void }) {
  const { game } = useContext(DeclarationsContext);
  const { search } = useContext(SearchContext);
  const { hash } = useLocation();

  function target(gameId: string) {
    return { pathname: consolePath(gameId), hash: hash || (search ? `#search=${encodeURIComponent(search)}` : "") };
  }

  return (
    <Group aria-label="Games">
      <GroupLabel>Game</GroupLabel>
      {GAME_LIST.map((g) => (
        <NavRow
          key={g.id}
          to={target(g.id)}
          onClick={onNavigate}
          data-current={g.id === game || undefined}
          aria-current={g.id === game ? "true" : undefined}
        >
          <GameIcon game={g.id} />
          {g.name}
        </NavRow>
      ))}
    </Group>
  );
}

/** Filters of what the page's list shows. They sit under the games and look like them */
export function ShowGroup({ children }: { children: ReactNode }) {
  return (
    <ShowRows aria-label="Show">
      <GroupLabel>Show</GroupLabel>
      {children}
    </ShowRows>
  );
}

/** A show filter, current like a game row when it's on */
export const ShowRow = styled.button`
  ${sidebarRow}

  > span {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &[aria-pressed="true"] {
    ${currentRow}
  }
`;

/** Takes the place of an icon */
export const ShowRowSpacer = styled.span`
  width: 16px;
  flex-shrink: 0;
`;

const Top = styled.div`
  flex-shrink: 0;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--row-line);
`;

const BrandRow = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  /* Centered on the navbar's search box next to it */
  height: 38px;
  margin: 4px 0 2px;
`;

const Brand = styled.a`
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 16px;
  text-decoration: none;
  color: var(--text);
  white-space: nowrap;
`;

const IconButton = styled.button`
  ${iconButton}
`;

// through CSS, because the prerendered page can't know it
// Pushes itself and the close button after it to the end of the row. The icon follows the theme
const ThemeToggle = styled.button`
  ${iconButton}
  margin-left: auto;

  [data-theme="dark"] & > .sun,
  :root:not([data-theme="dark"]) & > .moon {
    display: none;
  }
`;

const Group = styled.nav`
  display: flex;
  flex-direction: column;
`;

// A fieldset groups the filters for assistive tech, without its default frame
const ShowRows = styled.fieldset`
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
`;

// Lines up with the rows' text past their icon, like the list's group headers past their chevron
const GroupLabel = styled.div`
  padding: 8px 10px 4px 32px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
`;

const NavRow = styled(Link)`
  ${sidebarRow}

  &[data-current] {
    ${currentRow}
  }
`;
