import { GameId } from "../games-list";
import { parseOptions, type ParsedOptions } from "./options";
import type { OptionsJson } from "./types";

const optionUrls = import.meta.glob<string>("../../schemas/*.json.gz", {
  import: "default",
  query: "?url",
  eager: true,
});

function optionsUrl(gameId: GameId): string {
  const url = optionUrls[`../../schemas/${gameId}.json.gz`];
  if (!url) throw new Error(`No options found for ${gameId}`);
  return url;
}

export async function loadGameOptions(gameId: GameId): Promise<ParsedOptions> {
  const url = optionsUrl(gameId);
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error("Network request failed. Check your internet connection.");
  }
  if (!response.ok) throw new Error(`Server returned ${response.status} for ${url}`);

  const data: OptionsJson = await new Response(
    response.body!.pipeThrough(new DecompressionStream("gzip")),
  ).json();

  return parseOptions(data);
}
