import { useSyncExternalStore } from "react";

/**
 * Light/dark theme for the Weeber product surfaces (/dashboard + /app).
 * The resolved theme toggles the `dark` class on the shell root element
 * (not <html>), so the public landing/docs pages are unaffected.
 * No stored value = follow the OS preference.
 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "weeber_theme";

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function systemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedTheme(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : null;
}

export function currentTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

export function setTheme(theme: Theme | null) {
  if (theme === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, theme);
  emit();
}

export function toggleTheme() {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", cb);
  return () => {
    listeners.delete(cb);
    media.removeEventListener("change", cb);
  };
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  return { theme, toggle: toggleTheme };
}
