import { memo, useState } from "react";
import { styled } from "@linaria/react";
import {
  FLAGS,
  getTagState,
  hasTagFilters,
  type FilterTag,
  type ParsedConsoleSearch,
  type TagState,
} from "../../utils/console-filtering";
import { SidebarCount, SidebarGroupHeader, SidebarList } from "../layout/Sidebar";
import { ShowGroup, ShowRow, ShowRowSpacer } from "../layout/SidebarTop";
import { sidebarRow, sidebarRowSelected } from "../layout/sidebar-styles";
import { KindIcon } from "../kind-icon/KindIcon";
import type { ConsoleFilters } from "./ConsolePage";

const KINDS = [
  { kind: "all", label: "All", icon: null },
  { kind: "values", label: "Takes value", icon: "meta-variable" },
  { kind: "unmapped", label: "Unmapped", icon: "flag" },
] as const;

// A chip's tooltip says what clicking it does. Flags add what the flag means, since their names don't
const TAG_TITLE: Record<TagState, (value: string) => string> = {
  off: (v) => `Only show ${v}`,
  include: (v) => `Click again to hide ${v}`,
  exclude: (v) => `Stop hiding ${v}`,
};

const FLAG_TITLE: Record<TagState, (flag: string) => string> = {
  off: (f) => `Only show options that are ${f}. ${FLAGS[f]?.tip ?? ""}`,
  include: (f) => `Click again to hide options that are ${f}`,
  exclude: (f) => `Stop hiding options that are ${f}`,
};

/** Convars, commands, or both, above the list where it stays in view */
export function ConsoleShow({ filters }: { filters: ConsoleFilters }) {
  const { kind, kindCounts, stats, setKind } = filters;
  const rows = KINDS.filter((k) => k.kind !== "unmapped" || stats.unmapped > 0);
  return (
    <ShowGroup>
      {rows.map(({ kind: k, label, icon }) => (
        <ShowRow key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
          {icon ? <KindIcon kind={icon} /> : <ShowRowSpacer />}
          <span>{label}</span>
          <SidebarCount>{kindCounts[k].toLocaleString("en-US")}</SidebarCount>
        </ShowRow>
      ))}
    </ShowGroup>
  );
}

export const ConsoleSidebar = memo(function ConsoleSidebar({
  filters,
}: {
  filters: ConsoleFilters;
}) {
  const { kind, moduleCounts, typeCounts, flagCounts, stats, parsed, cycleTag, clearFilters } =
    filters;
  const hasFilters = kind !== "all" || hasTagFilters(parsed);

  return (
    <>
      <SidebarList>
        <TagGroup
          title="Flags"
          tag="flag:"
          values={stats.sorted.flags}
          counts={flagCounts}
          parsed={parsed}
          titleOf={FLAG_TITLE}
          onToggle={cycleTag}
        />
        <TagGroup
          title="Types"
          tag="type:"
          values={stats.sorted.types}
          counts={typeCounts}
          parsed={parsed}
          titleOf={TAG_TITLE}
          onToggle={cycleTag}
        />
        <TagGroup
          title="Modules"
          tag="module:"
          values={stats.sorted.modules}
          counts={moduleCounts}
          parsed={parsed}
          titleOf={TAG_TITLE}
          onToggle={cycleTag}
        />
      </SidebarList>
      {hasFilters && <ClearButton onClick={clearFilters}>Clear filters</ClearButton>}
    </>
  );
});

function Group({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <>
      <SidebarGroupHeader
        data-collapsed={collapsed || undefined}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        {title}
        {count !== undefined && <SidebarCount>{count}</SidebarCount>}
      </SidebarGroupHeader>
      {!collapsed && <GroupItems>{children}</GroupItems>}
    </>
  );
}

function TagGroup({
  title,
  tag,
  values,
  counts,
  parsed,
  titleOf,
  onToggle,
}: {
  title: string;
  tag: FilterTag;
  values: string[];
  counts: Map<string, number>;
  parsed: ParsedConsoleSearch;
  titleOf: Record<TagState, (value: string) => string>;
  onToggle: (tag: FilterTag, value: string) => void;
}) {
  return (
    <Group title={title} count={values.length}>
      {values.map((v) => {
        const state = getTagState(parsed, tag, v);
        const count = counts.get(v) ?? 0;
        return (
          <FilterItem
            key={v}
            data-state={state}
            data-empty={count === 0 || undefined}
            aria-pressed={state === "include"}
            title={titleOf[state](v)}
            onClick={() => onToggle(tag, v)}
          >
            <ShowRowSpacer />
            <ItemName>{v}</ItemName>
            {state === "exclude" && <VisuallyHidden>(hidden)</VisuallyHidden>}
            <SidebarCount>{count.toLocaleString("en-US")}</SidebarCount>
          </FilterItem>
        );
      })}
    </Group>
  );
}

const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
`;

const GroupItems = styled.div`
  padding-bottom: 8px;
`;

const ItemName = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const FilterItem = styled.button`
  ${sidebarRow}
  position: relative;

  &[data-empty] {
    color: var(--text-dim);
  }

  &[data-state="include"] {
    ${sidebarRowSelected}
  }

  &[data-state="exclude"] {
    background: color-mix(in srgb, var(--flag-cheat) 9%, transparent);
    border-left-color: var(--flag-cheat);
    color: var(--text-dim);

    ${ItemName} {
      text-decoration: line-through;
    }
  }
`;

const ClearButton = styled.button`
  flex-shrink: 0;
  margin: 8px 0;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--group-border);
  background: var(--group);
  font-size: 14px;
  color: var(--text);
  cursor: pointer;

  &:hover {
    border-color: var(--highlight);
  }
`;
