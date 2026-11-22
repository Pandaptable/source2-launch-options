import { useMemo, useState, type ReactNode } from "react";
import { styled } from "@linaria/react";
import { GAME_LIST, type GameId } from "../games-list";
import { getGameContext, type GameContext } from "../data/options";
import { itemTypes } from "../utils/console-filtering";
import { murmur2 } from "../utils/murmur";
import { GameIcon, KindIcon } from "./kind-icon/KindIcon";
import { isGameId } from "../games-list";
import { registerTooltip, tip } from "./Tooltip";
import { Card, CardBody, CardHeader, CardTitle } from "./styles";


const CheckerInput = styled.input`
  width: 100%;
  padding: 8px 14px;
  border: none;
  border-radius: 8px;
  background: var(--searchbox-background);
  color: var(--text);
  font-family: var(--font-mono, monospace);
  font-size: 15px;
  outline: none;

  &:focus {
    box-shadow: 0 0 0 2px var(--highlight);
  }

  &::placeholder {
    color: var(--searchbox-placeholder);
    font-family: inherit;
  }
`;

const CommandLine = styled.p`
  margin: 12px 0 0;
  font-family: var(--font-mono, monospace);
  font-size: 15px;
  line-height: 1.8;
  word-break: break-word;
`;

/** A launch option the binaries check: the one highlighted thing in the line */
const Arg = styled.span`
  padding: 2px 6px;
  border-radius: 5px;
  color: var(--green, #4caf7d);
  background: color-mix(in srgb, var(--green, #4caf7d) 14%, transparent);
  cursor: help;
`;

/** An option no dumped module checks for */
const DeadArg = styled.span`
  padding: 2px 6px;
  border-radius: 5px;
  color: var(--red, #e2705f);
  background: color-mix(in srgb, var(--red, #e2705f) 12%, transparent);
  text-decoration: line-through;
  cursor: help;
`;

/** The value after an option: kept in the line, never highlighted */
const Param = styled.span`
  color: var(--text-dim);
`;

/** A value with no option reading it */
const Stray = styled.span`
  color: var(--text-dim);
  opacity: 0.6;
  cursor: help;
`;

const Summary = styled.p`
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--text-dim);
`;

const TipGames = styled.span`
  display: flex;
  align-items: center;
  gap: 6px;
`;

const TipLine = styled.span`
  display: block;
`;

registerTooltip("checker-arg", (el) => {
  const ids = (el.dataset.games ?? "").split(",").filter(isGameId);
  const hash = el.dataset.hash ?? "";
  const modules = (el.dataset.modules ?? "").split(",").filter(Boolean);
  return (
    <>
      <TipGames>
        {ids.map((id) => (
          <GameIcon key={id} game={id} />
        ))}
      </TipGames>
      <TipLine>hash {hash}</TipLine>
      {modules.length > 0 && <TipLine>checked by {modules.join(", ")}</TipLine>}
    </>
  );
});


const Note = styled.p`
  margin: 0 0 10px;
  font-size: 14px;
  color: var(--text-dim);
`;

interface KnownOption {
  games: string[];
  modules: string[];
  takesValue: boolean;
}

/** Every game's known options by name, with the modules that check them */
function useKnownOptions(): Map<GameId, Map<string, KnownOption>> {
  return useMemo(() => {
    const known = new Map<GameId, Map<string, KnownOption>>();
    for (const g of GAME_LIST) {
      const byName = new Map<string, KnownOption>();
      for (const item of getGameContext(g.id).consoleItems) {
        if (!item.name) continue;
        const entry = byName.get(item.name);
        if (entry) {
          entry.modules = [...new Set([...entry.modules, ...item.modules])];
        } else {
          byName.set(item.name, {
            games: [g.id],
            modules: [...item.modules],
            takesValue: itemTypes(item).length > 0,
          });
        }
      }
      known.set(g.id, byName);
    }
    return known;
  }, []);
}

/** A launch options line in: the same line out, its launch options highlighted */
export function OptionChecker() {
  const known = useKnownOptions();
  const [value, setValue] = useState("");

  const tokens = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^["']+|["']+$/g, ""));

  const parts: ReactNode[] = [];
  const games = new Set<string>();
  let checked = 0;
  let dead = 0;
  let expectsValue = false;

  for (const token of tokens) {
    const found = GAME_LIST.map((g) => known.get(g.id)?.get(token)).filter(
      (o): o is KnownOption => o != null,
    );
    const isArg = token.startsWith("-") || token.startsWith("+");

    if (found.length > 0 || isArg) {
      checked++;
      if (found.length > 0) {
        const option = found[0];
        for (const f of found) games.add(f.games[0]);
        expectsValue = option.takesValue;
        parts.push(
          <Arg
            key={token + parts.length}
            data-tip-kind="checker-arg"
            data-games={found.map((f) => f.games[0]).join(",")}
            data-hash={String(murmur2(token))}
            data-modules={option.modules.slice(0, 5).join(",") + (option.modules.length > 5 ? ` +${option.modules.length - 5} more` : "")}
          >
            {token}
          </Arg>,
        );
      } else {
        dead++;
        expectsValue = false;
        parts.push(
          <DeadArg key={token + parts.length} {...tip(`${token} · hash ${murmur2(token)} · not found in any dumped module`)}>
            {token}
          </DeadArg>,
        );
      }
    } else if (expectsValue) {
      parts.push(
        <Param key={token + parts.length} {...tip("Value of the option before it")}>
          {token}
        </Param>,
      );
      expectsValue = false;
    } else {
      parts.push(
        <Stray key={token + parts.length} {...tip("Not a launch option: no option before it reads a value")}>
          {token}
        </Stray>,
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <KindIcon kind="command" />
        <CardTitle>Launch option check</CardTitle>
      </CardHeader>
      <CardBody>
        <Note>
          Paste your launch options. Every token is hashed (MurmurHash2, seed 0x31415926) and
          checked against every dumped module, so dead options show up.
        </Note>
        <CheckerInput
          type="text"
          placeholder="-novid -high -refresh 144 +mat_queue_mode 2 ..."
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {parts.length > 0 && (
          <>
            <CommandLine>{parts.flatMap((p, i) => (i === 0 ? [p] : [" ", p]))}</CommandLine>
            <Summary>
              {checked} option{checked === 1 ? "" : "s"} checked
              {dead > 0 && ` · ${dead} not found in any dumped module`}
              {games.size > 0 && ` · recognized in ${[...games].join(", ")}`}
            </Summary>
          </>
        )}
      </CardBody>
    </Card>
  );
}
