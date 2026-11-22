import { Fragment, memo, useContext, useState, type MouseEvent } from "react";
import { styled } from "@linaria/react";
import type { ConsoleItem } from "../../data/types";
import { HighlightRanges } from "../search/Highlight";
import { GameIcon, KindIcon } from "../kind-icon/KindIcon";
import type { GameId } from "../../games-list";
import { tip } from "../Tooltip";
import { getConsoleStats, itemTypes, type FilterTag } from "../../utils/console-filtering";
import { hover, hoverAndPress } from "../interaction-styles";
import { DeclarationsContext } from "../OptionsContext";

const flagChipStyles = `
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  border: 1px solid var(--group-border);
  background: var(--group-members);
  color: var(--text-dim);
  white-space: nowrap;
  position: relative;
  --c: var(--text-dim);

  &[data-group]:not([data-group="hidden"]) {
    color: var(--c);
    background: color-mix(in srgb, var(--c) 12%, transparent);
    border-color: color-mix(in srgb, var(--c) 35%, transparent);
  }
  &[data-group="hidden"] {
    border-style: dashed;
  }

  /* The exclusive flag is only the game's icon */
  &[data-plain] {
    padding: 0;
    border: none;
    background: none;

    /* As tall and round as the pills next to it */
    > svg {
      width: 20px;
      height: 20px;
      border-radius: 4px;
    }
  }
`;

const FlagChip = styled.span`
  ${flagChipStyles}
`;

const FlagChipButton = styled.button`
  ${flagChipStyles}
  cursor: pointer;

  ${hoverAndPress("border-color: var(--c);")}
`;

/** A module, styled like the flags it sits inline with */
function ModuleBadge({ module, onClick }: { module: string; onClick?: () => void }) {
  const content = (
    <>
      <KindIcon kind="module" />
      {module}
    </>
  );
  return onClick ? (
    <FlagChipButton onClick={onClick} title={`Filter by module:${module}`}>
      {content}
    </FlagChipButton>
  ) : (
    <FlagChip>{content}</FlagChip>
  );
}
/** Modified clicks open links normally instead of navigating in place */
export function isPlainLeftClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

/** Lines, hover and the anchored row like the schema tables */
const Row = styled.li`
  padding: 6px 12px;
  border-bottom: 1px solid var(--row-line);
  word-break: normal;
  overflow-wrap: anywhere;

  &:last-child {
    border-bottom: none;
  }

  ${hover("background: var(--row-hover);")}

  &[data-anchored] {
    background: var(--search-highlight);
    box-shadow: inset 2px 0 0 var(--highlight);
  }
`;

const Line = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  min-width: 0;
`;

// CSS draws the row icon. An <svg><use> per row adds up over thousands of prerendered rows.
const Name = styled.a`
  font-weight: 600;
  font-size: 15px;
  color: var(--text);
  text-decoration: none;

  &::before {
    content: "";
    display: inline-block;
    width: 16px;
    height: 16px;
    margin-right: 8px;
    vertical-align: -2px;
    background: var(--icon-teal);
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M6 9.5c.93 0 1.71.64 1.94 1.5h5.56c.28 0 .5.22.5.5s-.22.5-.5.5H7.94c-.23.86-1.01 1.5-1.94 1.5s-1.71-.64-1.94-1.5H2.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5h1.56c.23-.86 1.01-1.5 1.94-1.5zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4-8c.93 0 1.71.64 1.94 1.5h1.56c.28 0 .5.22.5.5s-.22.5-.5.5h-1.56c-.23.86-1.01 1.5-1.94 1.5s-1.71-.64-1.94-1.5H2.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5h5.56c.23-.86 1.01-1.5 1.94-1.5zm0 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z'/%3E%3C/svg%3E")
      center / contain no-repeat;
  }

  &:hover {
    text-decoration: underline;
    text-decoration-color: var(--text-dim);
  }

  /* Options that read a value after the token stand out by color alone */
  &[data-value] {
    color: var(--syntax-literal);

    &::before {
      background: var(--syntax-literal);
    }
  }
`;

/** Blue like builtin types on the schema pages */
const Type = styled.span`
  font-size: 14px;
  color: var(--syntax-literal);
`;

const Value = styled.span`
  font-size: 14px;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 4px;
`;

const Range = styled.span`
  font-size: 13px;
  color: var(--text-dim);
`;

const Swatch = styled.span`
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid var(--group-border);
`;

const Chips = styled.div`
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;

  @media (max-width: 768px) {
    margin-left: 0;
    flex-basis: 100%;
    order: 10;
  }
`;

const Help = styled.div`
  margin: 2px 0 0 24px;
  font-size: 14px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  &[data-missing] {
    font-style: italic;
    opacity: 0.7;
  }

  /* The linked row shows all of it, with the help's own line breaks */
  &[data-full] {
    white-space: pre-line;
    overflow-wrap: anywhere;
  }

  @media (max-width: 768px) {
    margin-left: 0;
  }
`;

export interface ConsoleRowProps {
  item: ConsoleItem;
  /** The parts of the name a search matched, to highlight */
  nameRanges?: readonly number[];
  anchored: boolean;
  /** href of the page the row links to, without hash, when it isn't the current page */
  pageHref?: string;
  onNavigate: (name: string, e: MouseEvent) => void;
  /** Rows without it show flags and modules as plain, non-clickable badges */
  onFilter?: (tag: FilterTag, value: string) => void;
  /** The module: filter's values. Their modules are shown before the others */
  filteredModules?: readonly string[];
  /** Set by the virtualized list */
  rowRef?: (el: HTMLLIElement | null) => void;
  index?: number;
  top?: number;
}

const MODULES_SHOWN = 2;

/**
 * The modules a filter asks for first, then the rarest, which tell the entry apart. The ones
 * nearly everything is in, like client and server, say the least
 */
function orderModules(
  modules: readonly string[],
  counts: ReadonlyMap<string, number>,
  filtered: readonly string[] = [],
): string[] {
  const isFiltered = (m: string) => filtered.some((f) => m.includes(f));

  return [...modules].sort((a, b) => {
    const filteredFirst = Number(isFiltered(b)) - Number(isFiltered(a));
    if (filteredFirst !== 0) return filteredFirst;

    return (counts.get(a) ?? 0) - (counts.get(b) ?? 0);
  });
}

export const ConsoleRow = memo(function ConsoleRow({
  item,
  nameRanges,
  anchored,
  pageHref = "",
  onNavigate,
  onFilter,
  filteredModules,
  rowRef,
  index,
  top,
}: ConsoleRowProps) {
  const label = item.name ?? String(item.hash);
  const href = `${pageHref}#name=${encodeURIComponent(label)}`;
  const unmapped = item.name == null;

  // Some are in dozens of modules. The rarest few are enough until the reader asks for the rest
  const { consoleItems } = useContext(DeclarationsContext);
  const [showAllModules, setShowAllModules] = useState(false);
  const manyModules = item.modules.length > MODULES_SHOWN + 1;
  const ordered = manyModules
    ? orderModules(item.modules, getConsoleStats(consoleItems).modules, filteredModules)
    : item.modules;
  const collapseModules = manyModules && !showAllModules;
  const modules = collapseModules ? ordered.slice(0, MODULES_SHOWN) : ordered;
  const hiddenModules = collapseModules ? ordered.slice(MODULES_SHOWN) : [];

  return (
    <Row
      ref={rowRef}
      data-index={index}
      style={
        top != null
          ? {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${top}px)`,
          }
          : undefined
      }
      data-anchored={anchored || undefined}
    >
      <Line>
        <Name
          href={href}
          onClick={(e) => onNavigate(label, e)}
          data-value={(item.valueTypes != null || item.value === true) || undefined}
          {...(item.valueTypes != null || item.value === true
            ? tip(
              item.valueTypes
                ? `Reads a value after the token (${item.valueTypes.join(", ")})`
                : "Reads a value after the token",
            )
            : {})}
        >
          {nameRanges ? <HighlightRanges text={label} ranges={nameRanges} /> : label}
        </Name>
        {itemTypes(item).map((t) => (
          <Type key={t}>{t}</Type>
        ))}
        <Value {...tip("MurmurHash2 token hash (seed 0x31415926) of the token, decimal, what the binary compares")}>
          {String(item.hash)}
        </Value>
        <Range {...tip("The same token hash, hexadecimal")}>0x{item.hash.toString(16)}</Range>
        <Chips>
          {item.locked && (
            <FlagChip
              {...tip(
                "Every check of this option is lock-gated: it only answers when the process is launched with -tools, -dedicated or -insecure",
              )}
            >
              locked
            </FlagChip>
          )}
          {item.elsewhere?.map((g) => (
            <Elsewhere key={g} {...tip(`Also checked by ${g} binaries`)} aria-label={g}>
              <GameIcon game={g as GameId} />
            </Elsewhere>
          ))}
          {modules.map((m) => (
            <ModuleBadge key={m} module={m} onClick={onFilter && (() => onFilter("module:", m))} />
          ))}
          {hiddenModules.length > 0 && (
            <FlagChipButton
              aria-expanded={false}
              onClick={() => setShowAllModules(true)}
              {...tip(hiddenModules.join(", "))}
            >
              +{hiddenModules.length} modules
            </FlagChipButton>
          )}
        </Chips>
      </Line>
      {(item.requires || item.alternatives) && (
        <Relations>
          {item.requires && item.requires.length > 0 && (
            <RelGroup {...tip("This option's check only runs when these are also present")}>
              needs:{" "}
              {item.requires.map((r, i) => (
                <Fragment key={r}>
                  {i > 0 && ", "}
                  <RelLink href={`${pageHref}#name=${encodeURIComponent(r)}`} onClick={(e) => onNavigate(r, e)}>
                    {r}
                  </RelLink>
                </Fragment>
              ))}
            </RelGroup>
          )}
          {item.alternatives && item.alternatives.length > 0 && (
            <RelGroup {...tip("The same check accepts any of these tokens. Only shown when the pair is checked together at every call site of both options")}>
              aliases:{" "}
              {item.alternatives.map((a, i) => (
                <Fragment key={a}>
                  {i > 0 && ", "}
                  <RelLink href={`${pageHref}#name=${encodeURIComponent(a)}`} onClick={(e) => onNavigate(a, e)}>
                    {a}
                  </RelLink>
                </Fragment>
              ))}
            </RelGroup>
          )}
        </Relations>
      )}
      {unmapped && <Help data-missing>unmapped, referenced with no known token</Help>}
      {anchored && item.sites != null && item.sites.length > 0 && (
        <Sites>
          {item.sites.map((s, i) => (
            <Fragment key={`${s.m}-${s.va}-${i}`}>
              <SiteLine>
                <SiteModule>{s.m}</SiteModule>
                <code
                  {...tip(
                    `Call site in ${s.m}: image base + 0x${(
                      parseInt(s.va, 16) - 0x180000000
                    ).toString(16)}${s.fn ? `, inside function ${s.fn}` : ""}`,
                  )}
                >
                  {s.va}
                </code>
                <SiteMethod>{s.method}</SiteMethod>
                {s.inlined && (
                  <SiteMethod {...tip("One copy of an inlined helper: the same check shape is stamped across many functions of this module")}>
                    inlined
                  </SiteMethod>
                )}
                {s.gate === "locked" && (
                  <FlagChip {...tip("Only answers with -tools, -dedicated or -insecure")}>locked</FlagChip>
                )}
              </SiteLine>
              {s.more && (
                <SiteLine data-more>
                  <SiteModule>{s.m}</SiteModule>
                  <span>
                    {s.more.count - 1} more checks in {s.more.fns - 1} more functions
                    {s.more.inlined ? ", all inlined copies of one helper" : ""}
                  </span>
                </SiteLine>
              )}
            </Fragment>
          ))}
        </Sites>
      )}
    </Row >
  );
});

const Relations = styled.div`
  margin: 2px 0 0 24px;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 16px;
  font-size: 13px;
  color: var(--text-dim);

  @media (max-width: 768px) {
    margin-left: 0;
  }
`;

const RelGroup = styled.span`
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
`;

const RelLink = styled.a`
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  text-decoration: none;

  &:hover {
    color: var(--highlight);
  }
`;

const Elsewhere = styled.span`
  display: inline-flex;
  align-items: center;
  color: var(--text-dim);
  cursor: default;

  svg {
    border-radius: 3px;
  }
`;

const Sites = styled.div`
  margin: 4px 0 0 24px;
  display: flex;
  flex-direction: column;
  gap: 2px;

  @media (max-width: 768px) {
    margin-left: 0;
  }
`;

const SiteLine = styled.div`
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  color: var(--text-dim);

  code {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 12px;
    color: var(--text);
  }
`;

const SiteModule = styled.span`
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  min-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const SiteMethod = styled.span`
  font-size: 12px;
`;
