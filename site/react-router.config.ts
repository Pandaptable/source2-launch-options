import type { Config } from "@react-router/dev/config";
import { GAME_LIST } from "./src/games-list.ts";

const isDev = process.argv.includes("dev");

export default {
  ssr: false,
  appDirectory: "src",
  basename: "/",
  prerender: isDev
    ? false
    : {
      concurrency: 8,
      async paths() {
        const paths = ["/"];
        for (const game of GAME_LIST) {
          paths.push(`/${game.id}`);
          paths.push(`/${game.id}/options`);
        }
        return paths;
      },
    },
} satisfies Config;
