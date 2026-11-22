import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";

/** The hash of a link to a page, from its parameters. Null and empty values are left out */
export function buildHash(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") search.set(key, value);
  }
  const text = search.toString();
  return text ? `#${text}` : "";
}

/** One parameter of the location hash, rerendering when it changes */
export function useHashParam(name: string): string | null {
  const { hash } = useLocation();
  return useMemo(() => new URLSearchParams(hash.slice(1)).get(name), [hash, name]);
}

/** True once React has hydrated the prerendered page */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
