import React, { useLayoutEffect, useMemo } from "react";
import { flushSync } from "react-dom";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { styled } from "@linaria/react";
import { AppContext } from "./components/AppContext";
import { TooltipHost } from "./components/Tooltip";
import { SITE_NAME } from "./games-list";
import searchPrehydrate from "./search-prehydrate.js?url";
import interLatin from "inter-ui/variable-latin/InterVariable-subset.woff2?url";
import favicon from "./favicon.svg?url";
import faviconLegacy from "./favicon.ico?url";
import "./global.css";

/** The browser chrome and phone status bar match the navbar, which is --background in global.css */
const THEME_COLORS = { light: "#f8f9fb", dark: "#0c131d" };

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href={favicon} type="image/svg+xml" />
        <link rel="alternate icon" href={faviconLegacy} sizes="any" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content={SITE_NAME} />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content={THEME_COLORS.light}
        />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={THEME_COLORS.dark} />
        <link rel="preload" href={interLatin} as="font" type="font/woff2" crossOrigin="anonymous" />
        <Meta />
        <Links />
        <script
          dangerouslySetInnerHTML={{
            __html: `var t=localStorage.getItem("theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.setAttribute("data-theme","dark")`,
          }}
        />
      </head>
      <body>
        {children}
        <TooltipHost />
        <script src={searchPrehydrate} />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function applyTheme(dark: boolean) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  // The theme picked on the site can differ from the system one the media queries follow
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", dark ? THEME_COLORS.dark : THEME_COLORS.light);
  }
}

const AppWrapper = styled.div`
  display: flex;
  flex-flow: column;
  min-height: 100dvh;
  max-width: 1440px;
  margin: 0 auto;
  background-color: var(--background);
  color: var(--text);
`;

export function HydrateFallback() {
  return null;
}

export default function Root() {
  const [darkmode, setDarkmode] = React.useState(() => {
    if (typeof window === "undefined") return false;
    const t = localStorage.getItem("theme");
    return t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme:dark)").matches);
  });

  useLayoutEffect(() => {
    applyTheme(darkmode);
  }, [darkmode]);

  const appContext = useMemo(
    () => ({
      darkmode,
      setDarkmode(dark: boolean) {
        window.localStorage.setItem("theme", dark ? "dark" : "light");
        const update = () => {
          applyTheme(dark);
          flushSync(() => setDarkmode(dark));
        };
        if (document.startViewTransition) document.startViewTransition(update);
        else update();
      },
    }),
    [darkmode],
  );

  return (
    <AppContext.Provider value={appContext}>
      <AppWrapper>
        <Outlet />
      </AppWrapper>
    </AppContext.Provider>
  );
}
