import React, {
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { styled } from "@linaria/react";
import { getGameContext, type GameContext } from "../../data/options";
import { GAME_LIST, dumpFileUrl, getGameDef, type GameId } from "../../games-list";
import { buildHash, useHashParam, useHydrated } from "../../utils/filtering";
import type { ConsoleItem } from "../../data/types";
import { countBy } from "../../utils/collections";
import { TIER_EXACT } from "../../utils/match-score";
import {
  filterConsoleItems,
  getConsoleStats,
  getTagState,
  itemFlags,
  itemTypes,
  moduleFilter,
  nextTagState,
  parseConsoleSearch,
  searchConsoleItems,
  searchConsoleResults,
  setSearchTag,
  stripConsoleFilters,
  typeFilter,
  withoutFlag,
  type ConsoleKind,
  type ConsoleMatch,
  type FilterTag,
  type ParsedConsoleSearch,
} from "../../utils/console-filtering";
import { DeclarationsContext } from "../OptionsContext";
import { PageTitle } from "../styles";
import { SearchContext } from "../search/SearchContext";
import { PageProviders, PageShell } from "../layout/PageShell";
import { ContentWrapper, OtherGameHeading, SiteFooter, TextMessage } from "../layout/Content";
import { isPlainLeftClick } from "./ConsoleRow";
import { ConsoleRowsCard } from "./ConsoleRowsCard";
import { GitHubButton } from "../GitHubButton";
import { ConsoleShow, ConsoleSidebar } from "./ConsoleSidebar";
import { StaticConsoleList } from "./StaticConsoleList";
import { useFirstInteraction } from "./useFirstInteraction";
import { VirtualConsoleList } from "./VirtualConsoleList";

export default function ConsolePage({ context }: { context: GameContext }) {
  return (
    <PageProviders context={context}>
      <ConsoleLayout />
    </PageProviders>
  );
}

function ConsoleLayout() {
  const filters = useConsoleFilters();
  return (
    <PageShell
      count={filters.visible.length.toLocaleString("en-US")}
      show={<ConsoleShow filters={filters} />}
      sidebar={() => <ConsoleSidebar filters={filters} />}
    >
      <ConsoleContent filters={filters} />
    </PageShell>
  );
}

export type ConsoleFilters = ReturnType<typeof useConsoleFilters>;

function inKind(matches: ConsoleMatch[], kind: ConsoleKind): ConsoleMatch[] {
  if (kind === "all") return matches;
  if (kind === "unmapped") return matches.filter(({ item }) => item.name == null);
  if (kind === "values") return matches.filter(({ item }) => item.value === true);
  const wantConvars = kind === "convars";
  return matches.filter(({ item }) => (item.kind === "convar") === wantConvars);
}

function inModules(
  matches: ConsoleMatch[],
  matchesModules: ReturnType<typeof moduleFilter>,
): ConsoleMatch[] {
  if (!matchesModules) return matches;
  return matches.filter(({ item }) => matchesModules(item));
}

/** The matches that pass the type filters */
function inTypes(
  matches: ConsoleMatch[],
  matchesTypes: ReturnType<typeof typeFilter>,
): ConsoleMatch[] {
  if (!matchesTypes) return matches;
  return matches.filter(({ item }) => matchesTypes(item));
}

const asMatch = (item: ConsoleItem): ConsoleMatch => ({ item, tier: TIER_EXACT });

/** Filter state shared by the sidebar and the list. All of it lives in the URL hash */
function useConsoleFilters() {
  const { consoleItems } = useContext(DeclarationsContext);
  const { search } = useContext(SearchContext);
  const kindParam = useHashParam("kind");
  const nameParam = useHashParam("name");
  const kind: ConsoleKind =
    kindParam === "convars" || kindParam === "commands" || kindParam === "unmapped" || kindParam === "values"
      ? kindParam
      : "all";

  const navigate = useNavigate();
  const stats = getConsoleStats(consoleItems);
  // An #kind=unmapped link from when the dump had unknowns would show an empty list
  const effKind = kind === "unmapped" && stats.unmapped === 0 ? "all" : kind;

  const deferredSearch = useDeferredValue(search);
  const parsed = useMemo(() => parseConsoleSearch(deferredSearch), [deferredSearch]);

  const { visible, similar, kindCounts, moduleCounts, typeCounts, flagCounts } = useMemo(() => {
    // One scored pass without module and type filters, which their own counts ignore anyway
    const found = searchConsoleItems(consoleItems, parsed, { ignoreModules: true, ignoreTypes: true });
    const matchesModules = moduleFilter(parsed, stats);
    const matchesTypes = typeFilter(parsed, stats);
    const rest = inTypes(found.results, matchesTypes);
    const allKinds = inModules(rest, matchesModules);
    let convars = 0;
    let unmapped = 0;
    let values = 0;
    for (const { item } of allKinds) {
      if (item.kind === "convar") convars++;
      else if (item.name == null) unmapped++;
      if (item.value === true) values++;
    }
    const commands = allKinds.length - convars - unmapped;
    const visible = inKind(allKinds, effKind);

    // Names that only match fuzzily are listed apart. None of the counts include them
    const similar = inKind(
      inModules(inTypes(found.similar, matchesTypes), matchesModules),
      effKind,
    );

    // Each group's chips count what they would add to every other filter
    const moduleMatches = matchesModules ? inKind(rest, effKind) : visible;
    const typeMatches = matchesTypes
      ? inKind(inModules(found.results, matchesModules), effKind)
      : visible;

    // Every other active filter already narrowed `visible`, so counting flags there gives each
    // unselected flag's count. A flag that is included or excluded needs its own lifted first
    const flagCounts = countBy(visible, ({ item }) => itemFlags(item));
    for (const flag of new Set([...parsed.flags, ...parsed.notFlags])) {
      const others = withoutFlag(parsed, flag);
      flagCounts.set(
        flag,
        inKind(filterConsoleItems(consoleItems, others).map(asMatch), effKind).filter(
          ({ item }) => itemFlags(item).includes(flag),
        ).length,
      );
    }
    return {
      visible,
      similar,
      kindCounts: { all: allKinds.length, convars, commands, unmapped, values },
      moduleCounts: countBy(moduleMatches, ({ item }) => item.modules),
      typeCounts: countBy(typeMatches, ({ item }) => itemTypes(item)),
      flagCounts,
    };
  }, [consoleItems, parsed, effKind, stats]);

  // Callbacks read the hash through a ref so they stay stable for the memoized rows
  const hashRef = useRef({ search, kindParam });
  useLayoutEffect(() => {
    hashRef.current = { search, kindParam };
  });

  const setHash = useCallback(
    (params: { kind?: string | null; search?: string; name?: string }, replace = false) => {
      navigate({ hash: buildHash(params) }, { replace, preventScrollReset: true });
    },
    [navigate],
  );

  const cycleTag = useCallback(
    (tag: FilterTag, value: string) => {
      const { search, kindParam } = hashRef.current;
      const state = getTagState(parseConsoleSearch(search), tag, value);
      const next = nextTagState(tag, state);
      setHash({ kind: kindParam, search: setSearchTag(search, tag, value, next) });
    },
    [setHash],
  );

  // Row chips only add a filter. Cycling there would hide the row that was clicked
  const includeTag = useCallback(
    (tag: FilterTag, value: string) => {
      const { search, kindParam } = hashRef.current;
      setHash({ kind: kindParam, search: setSearchTag(search, tag, value, "include") });
    },
    [setHash],
  );

  const setKind = useCallback(
    (k: ConsoleKind) => {
      setHash({ kind: k === "all" ? null : k, search: hashRef.current.search });
    },
    [setHash],
  );

  const clearFilters = useCallback(
    () => setHash({ search: stripConsoleFilters(hashRef.current.search) }),
    [setHash],
  );

  const selectName = useCallback(
    (name: string) => {
      const { search, kindParam } = hashRef.current;
      setHash({ kind: kindParam, search, name }, true);
    },
    [setHash],
  );

  // Memoized so the sidebar skips the immediate render of a keystroke. Its data is deferred
  return useMemo(
    () => ({
      kind: effKind,
      nameParam,
      parsed,
      stats,
      visible,
      similar,
      kindCounts,
      moduleCounts,
      typeCounts,
      flagCounts,
      cycleTag,
      includeTag,
      setKind,
      clearFilters,
      selectName,
    }),
    [
      effKind,
      nameParam,
      parsed,
      stats,
      visible,
      similar,
      kindCounts,
      moduleCounts,
      typeCounts,
      flagCounts,
      cycleTag,
      includeTag,
      setKind,
      clearFilters,
      selectName,
    ],
  );
}

function ConsoleIntro() {
  return null;
}


function ConsoleContent({ filters }: { filters: ConsoleFilters }) {
  const { game, metadata } = useContext(DeclarationsContext);
  const { search } = useContext(SearchContext);
  const { kind, nameParam, parsed, visible, similar, includeTag, selectName } = filters;

  // The similar names asked for, for this list of them only
  const [expandedSimilar, setExpandedSimilar] = useState<ConsoleMatch[] | null>(null);
  const showAllSimilar = expandedSimilar === similar;
  const onShowAllSimilar = useCallback(() => setExpandedSimilar(similar), [similar]);

  // the reader does something, so a crawler that renders the page sees all of them too
  // The prerendered page has every row for search engines. It keeps them after hydration until
  const unfiltered = search === "" && kind === "all";
  const hydrated = useHydrated();
  const staticListRef = useRef<HTMLUListElement>(null);
  const interaction = useFirstInteraction(hydrated, staticListRef);
  const virtual = hydrated && (interaction != null || !unfiltered || nameParam != null);
  const restorePosition = unfiltered ? (interaction?.position ?? null) : null;

  // link opened from elsewhere (or back/forward to another name) scrolls to its row
  // Clicking a name only updates the permalink. The row is already in view. Only a #name=
  const clickedRef = useRef<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  useEffect(() => {
    const clicked = nameParam != null && nameParam === clickedRef.current;
    clickedRef.current = null;
    setScrollTarget(nameParam && !clicked ? nameParam : null);
  }, [nameParam]);

  const onNavigate = useCallback(
    (name: string, e: React.MouseEvent) => {
      if (!isPlainLeftClick(e)) return;
      e.preventDefault();
      clickedRef.current = nameParam === name ? null : name;
      selectName(nameParam === name ? "" : name);
    },
    [selectName, nameParam],
  );

  const gameName = getGameDef(game).name;

  const list = (
    <VirtualConsoleList
      items={visible}
      similar={similar}
      showAllSimilar={showAllSimilar}
      onShowAllSimilar={onShowAllSimilar}
      restorePosition={restorePosition}
      nameParam={nameParam}
      scrollTarget={scrollTarget}
      onNavigate={onNavigate}
      onFilter={includeTag}
      filteredModules={parsed.modules}
    />
  );

  let body: React.ReactNode;
  if (visible.length === 0) {
    body = (
      <>
        <TextMessage>No results found</TextMessage>
        <OtherGamesConsoleResults parsed={parsed} kind={kind} />
        {similar.length > 0 && list}
      </>
    );
  } else if (virtual) {
    body = list;
  } else {
    body = <StaticConsoleList listRef={staticListRef} items={visible} onNavigate={onNavigate} />;
  }

  const repoUrl = dumpFileUrl(game, "");

  return (
    <ContentWrapper>
      <Header>
        <PageTitle>{gameName} Launch Options</PageTitle>
        <HeaderActions>
          {repoUrl && <GitHubButton href={repoUrl} title="View the dumps on GitHub" label="hashes/" />}
        </HeaderActions>
      </Header>
      <ConsoleIntro />
      {body}

      <SiteFooter metadata={metadata} />
    </ContentWrapper>
  );
}

function OtherGamesConsoleResults({
  parsed,
  kind,
}: {
  parsed: ParsedConsoleSearch;
  kind: ConsoleKind;
}) {
  const { game } = useContext(DeclarationsContext);

  const results = useMemo(() => {
    const out: { gameId: GameId; found: ConsoleMatch[] }[] = [];
    if (parsed.nameWords.length === 0 && parsed.modules.length === 0 && parsed.notModules.length === 0) {
      return out;
    }
    for (const g of GAME_LIST) {
      if (g.id === game) continue;
      const { consoleItems } = getGameContext(g.id);
      const found = searchConsoleResults(consoleItems, parsed, { kind });
      if (found.length > 0) out.push({ gameId: g.id, found: found.slice(0, 100) });
    }
    return out;
  }, [game, parsed, kind]);

  return (
    <>
      {results.map(({ gameId, found }) => (
        <React.Fragment key={gameId}>
          <OtherGameHeading gameId={gameId} />
          <ConsoleRowsCard gameId={gameId} matches={found} />
        </React.Fragment>
      ))}
    </>
  );
}

const Header = styled.div`
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 4px 0 0 4px;
`;

const HeaderActions = styled.div`
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-left: auto;
`;

const Intro = styled.p`
  margin: 8px 0 0 4px;
  font-size: 15px;
  color: var(--text-dim);
`;
