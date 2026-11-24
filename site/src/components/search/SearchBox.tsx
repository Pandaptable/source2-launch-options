import React, { useContext, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useLocation, useNavigate } from "react-router";
import { buildHash } from "../../utils/filtering";
import { FLAGS, getConsoleStats } from "../../utils/console-filtering";
import { styled } from "@linaria/react";
import { hover } from "../interaction-styles";
import { SearchContext } from "./SearchContext";
import { MatchHighlight } from "./Highlight";
import { DeclarationsContext, consolePath } from "../OptionsContext";
import { KindIcon, type IconKind, UiIcon } from "../kind-icon/KindIcon";
import type { ConsoleItem } from "../../data/types";

export const SearchInput = styled.input`
  width: 100%;
  padding: 8px 14px;
  border: none;
  border-radius: 8px;
  background: var(--searchbox-background);
  color: var(--text);
  font-size: 16px;
  outline: none;
  transition: box-shadow 0.15s;

  ${hover("box-shadow: 0 0 0 2px color-mix(in srgb, var(--highlight) 19%, transparent);")}

  &:focus {
    box-shadow: 0 0 0 2px var(--highlight);
  }

  &::placeholder {
    color: var(--searchbox-placeholder);
  }
`;

declare global {
  interface Window {
    /** Set by search-prehydrate.js */
    stopSearchPrehydrate?: () => void;
  }
}

export interface SearchTag {
  tag: string;
  icon: IconKind;
  description: string;
  example: string;
}

const SEARCH_TAGS: readonly SearchTag[] = [
  {
    tag: "module:",
    icon: "module",
    description: "Filter by module that checks the option",
    example: "e.g. module:engine2.dll",
  },
  {
    tag: "flag:",
    icon: "flag",
    description: "Filter by a property of the option, like being lock-gated",
    example: "e.g. flag:locked",
  },
  {
    tag: "type:",
    icon: "meta-variable",
    description: "Filter by the type of value the option reads",
    example: "e.g. type:int",
  },
];

function getLastWord(input: string): string {
  if (input === "" || input.endsWith(" ")) return "";
  return input.split(" ").at(-1) ?? "";
}

function shouldShowFirstLevelPopup(input: string): boolean {
  if (input.endsWith(" ")) return false;
  return !getLastWord(input).includes(":");
}

/** Any filter tag can be negated with a leading "-" */
function negationPrefix(word: string): "-" | "" {
  return word.startsWith("-") ? "-" : "";
}

function filterTags(tags: readonly SearchTag[], lastWord: string) {
  if (lastWord === "") return tags;
  const lower = lastWord.toLowerCase().slice(negationPrefix(lastWord).length);
  return tags.filter((t) => t.tag.includes(lower));
}

/** Replaces the word being typed, or appends one after a space */
function replaceLastWord(inputValue: string, word: string): string {
  if (inputValue === "" || inputValue.endsWith(" ")) return inputValue + word;
  const parts = inputValue.split(" ");
  parts[parts.length - 1] = word;
  return parts.join(" ");
}

type ValueSuggestions = {
  tag: string;
  header: string;
  values: string[];
  counts?: Map<string, number>;
  /** What the site calls a value, shown beside it and matched too when it differs */
  label?: (value: string) => string;
};

function getSecondLevelContext(
  lastWord: string,
  suggestions: ValueSuggestions[],
): { prefix: string; value: string; suggestions: ValueSuggestions } | null {
  const lower = lastWord.toLowerCase();
  const negated = negationPrefix(lower);

  for (const sug of suggestions) {
    if (lower.startsWith(negated + sug.tag)) {
      return {
        prefix: negated + sug.tag,
        value: lastWord.slice(negated.length + sug.tag.length),
        suggestions: sug,
      };
    }
  }

  return null;
}

function getTagValueSuggestions(items: ConsoleItem[]): ValueSuggestions[] {
  const { sorted, modules, types, flags } = getConsoleStats(items);
  return [
    {
      tag: "flag:",
      header: "Flags",
      values: sorted.flags,
      counts: flags,
      label: (v) => FLAGS[v]?.label ?? v,
    },
    { tag: "type:", header: "Value types", values: sorted.types, counts: types },
    { tag: "module:", header: "Modules", values: sorted.modules, counts: modules },
  ];
}

const SearchBoxWrapper = styled.div`
  position: relative;
  width: 100%;

  > svg {
    position: absolute;
    left: 12px;
    top: 50%;
    translate: 0 -50%;
    pointer-events: none;
    color: var(--searchbox-placeholder);
  }
`;

const MainSearchInput = styled(SearchInput)`
  padding-left: 36px;
`;

const SearchPlaceholder = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 14px 0 36px;
  pointer-events: none;
  color: var(--searchbox-placeholder);
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;

  > span {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  kbd {
    font-size: 12px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--searchbox-placeholder);
    opacity: 0.6;
    line-height: 1.4;
  }
`;

const TagPopup = styled.div`
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--group);
  border: 1px solid var(--group-border);
  border-radius: 8px;
  box-shadow: var(--group-shadow);
  z-index: 200;
  overflow: hidden;
`;

const TagPopupHeader = styled.div`
  padding: 6px 12px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
`;

const TagItem = styled.button`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 12px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  &[data-active],
  &:hover {
    background: var(--group-members);
  }
`;

const TagItemText = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
`;

const TagItemName = styled.span`
  font-weight: 600;
  font-size: 13px;
`;

const TagItemDesc = styled.span`
  font-size: 12px;
  color: var(--text-dim);
`;

const TagItemExample = styled.span`
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0.6;
  flex-shrink: 0;
`;

const ValueCount = styled.span`
  margin-left: auto;
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
`;

const ValuePopupList = styled.div`
  max-height: 200px;
  overflow-y: auto;
`;

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <MatchHighlight>{text.slice(idx, idx + query.length)}</MatchHighlight>
      {text.slice(idx + query.length)}
    </>
  );
}

function ValueSuggestPopup({
  header,
  values,
  counts,
  label,
  activeIndex,
  onSelect,
  query,
}: {
  header: string;
  values: string[];
  counts?: Map<string, number>;
  label?: (value: string) => string;
  activeIndex: number;
  onSelect: (value: string) => void;
  query: string;
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
    <TagPopup role="listbox" id="search-listbox" aria-label={header}>
      <TagPopupHeader>{header}</TagPopupHeader>
      <ValuePopupList>
        {values.map((v, i) => {
          const name = label?.(v);
          return (
            // oxlint-disable-next-line jsx-a11y/interactive-supports-focus
            // oxlint-disable-next-line jsx-a11y/interactive-supports-focus
            <TagItem
              key={v}
              ref={i === activeIndex ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              aria-selected={i === activeIndex}
              data-active={i === activeIndex || undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(v);
              }}
            >
              <TagItemName>
                <HighlightMatch text={v} query={query} />
              </TagItemName>
              {name !== undefined && name !== v && (
                <TagItemDesc>
                  <HighlightMatch text={name} query={query} />
                </TagItemDesc>
              )}
              {counts && <ValueCount>{counts.get(v)}</ValueCount>}
            </TagItem>
          );
        })}
      </ValuePopupList>
    </TagPopup>
  );
}

function SearchTagPopup({
  tags,
  activeIndex,
  onSelect,
}: {
  tags: readonly SearchTag[];
  activeIndex: number;
  onSelect: (tag: string) => void;
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
    <TagPopup role="listbox" id="search-listbox" aria-label="Search tag suggestions">
      <TagPopupHeader>Filters</TagPopupHeader>
      {tags.map((t, i) => (
        <TagItem
          key={t.tag}
          ref={i === activeIndex ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
          aria-selected={i === activeIndex}
          data-active={i === activeIndex || undefined}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(t.tag);
          }}
        >
          <KindIcon kind={t.icon} />
          <TagItemText>
            <TagItemName>{t.tag}</TagItemName>
            <TagItemDesc>{t.description}</TagItemDesc>
          </TagItemText>
          <TagItemExample>{t.example}</TagItemExample>
        </TagItem>
      ))}
    </TagPopup>
  );
}

export function SearchBox({ className }: { className?: string }) {
  const { search } = useContext(SearchContext);
  const { game, consoleItems } = useContext(DeclarationsContext);
  const baseUrl = consolePath(game);
  const [inputValue, setInputValue] = useState(search);
  const [isFocused, setIsFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const [, startTransition] = useTransition();
  // The search this box last wrote to the URL. The input already shows it
  const ownSearchRef = useRef(search);

  // "/" focuses the search from anywhere outside an input
  // React owns the input now, so this stops the pre-hydration script from rewriting the history entry
  // Sync input value from URL (back/forward navigation, clicking links)
  useEffect(() => {
    const urlSearch = new URLSearchParams(location.hash.slice(1)).get("search") ?? "";
    if (urlSearch === ownSearchRef.current) return;
    ownSearchRef.current = urlSearch;
    setInputValue(urlSearch);
  }, [location.hash]);

  const valueSuggestions = useMemo(() => getTagValueSuggestions(consoleItems), [consoleItems]);

  const lastWord = getLastWord(inputValue);
  const filteredTags = filterTags(SEARCH_TAGS, lastWord);
  const showFirstLevel = isFocused && shouldShowFirstLevelPopup(inputValue) && filteredTags.length > 0;

  const secondLevel = getSecondLevelContext(lastWord, valueSuggestions);
  const secondLevelValues = useMemo(() => {
    if (!secondLevel) return [];
    const { values: list, label } = secondLevel.suggestions;
    if (secondLevel.value === "") return list;
    const lower = secondLevel.value.toLowerCase();
    return list.filter((v) => {
      if (v.toLowerCase().includes(lower)) return true;
      return label !== undefined && label(v).toLowerCase().includes(lower);
    });
  }, [secondLevel?.suggestions, secondLevel?.value]);
  const isExactMatch =
    secondLevel != null &&
    secondLevelValues.length === 1 &&
    secondLevelValues[0].toLowerCase() === secondLevel.value.toLowerCase();
  const showSecondLevel = isFocused && secondLevel != null && secondLevelValues.length > 0 && !isExactMatch;

  const showPopup = showFirstLevel || showSecondLevel;
  const popupLength = showFirstLevel ? filteredTags.length : secondLevelValues.length;

  const ref = useRef<HTMLInputElement>(null);

  const applyNewValue = (newValue: string) => {
    setInputValue(newValue);
    const replace = inputValue !== "" || newValue === "";

    // A directly loaded prerendered page can have a trailing slash
    // Other hash params, like the convars page kind filter, stay when searching on the same page.
    const samePage = location.pathname.replace(/\/$/, "") === baseUrl;
    const params = Object.fromEntries(new URLSearchParams(samePage ? location.hash.slice(1) : ""));
    const hash = buildHash({ ...params, name: null, search: newValue });
    ownSearchRef.current = newValue;

    startTransition(() => {
      navigate({ pathname: baseUrl, hash }, { replace });
    });

    setActiveIndex(0);
    ref.current?.focus();
  };

  const handleTagSelect = (tag: string) => {
    applyNewValue(replaceLastWord(inputValue, negationPrefix(lastWord) + tag));
  };

  const handleValueSelect = (value: string) => {
    if (!secondLevel) return;
    applyNewValue(replaceLastWord(inputValue, secondLevel.prefix + value));
  };

  const onChange: React.ChangeEventHandler<HTMLInputElement> = ({ target: { value } }) => {
    setIsFocused(true);
    applyNewValue(value);
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (showPopup) {
        setIsFocused(false);
      } else {
        ref.current?.blur();
      }
      return;
    }
    if (!showPopup) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, popupLength - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      // Tab completes only a word being typed. Otherwise it moves focus to the next element
      if (e.key === "Tab" && lastWord === "") return;
      e.preventDefault();

      if (showFirstLevel && filteredTags[activeIndex]) {
        handleTagSelect(filteredTags[activeIndex].tag);
      } else if (showSecondLevel && secondLevelValues[activeIndex]) {
        handleValueSelect(secondLevelValues[activeIndex]);
      }
    }
  };

  useEffect(() => {
    window.stopSearchPrehydrate?.();
  }, []);

  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!(document.activeElement instanceof HTMLInputElement)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  return (
    <SearchBoxWrapper className={className}>
      <UiIcon name="search" />
      {!inputValue && !isFocused && (
        <SearchPlaceholder>
          Type <kbd>/</kbd> <span>to search launch options</span>
        </SearchPlaceholder>
      )}
      <MainSearchInput
        id="main-search"
        type="search"
        ref={ref}
        value={inputValue}
        onChange={onChange}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onKeyDown={onKeyDown}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="combobox"
        tabIndex={0}
        aria-label="Search"
        aria-controls={showPopup ? "search-listbox" : undefined}
        aria-autocomplete="list"
        aria-expanded={showPopup}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      {showFirstLevel && (
        <SearchTagPopup tags={filteredTags} activeIndex={activeIndex} onSelect={handleTagSelect} />
      )}
      {showSecondLevel && secondLevel && (
        <ValueSuggestPopup
          header={secondLevel.suggestions.header}
          values={secondLevelValues}
          counts={secondLevel.suggestions.counts}
          label={secondLevel.suggestions.label}
          activeIndex={activeIndex}
          onSelect={handleValueSelect}
          query={secondLevel.value}
        />
      )}
    </SearchBoxWrapper>
  );
}
