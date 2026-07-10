import { describe, it, expect, beforeEach } from "bun:test";

// Mock localStorage and window for headless testing
const store: Record<string, string> = {};
global.localStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => {
    store[key] = val;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const k in store) delete store[k];
  },
  key: () => null,
  length: 0,
};

global.window = {
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
} as any;

import { currentTheme, setTheme, toggleTheme } from "./theme";

describe("theme utility", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to light theme when no storage and matchMedia is false", () => {
    expect(currentTheme()).toBe("light");
  });

  it("returns dark theme if stored in localStorage", () => {
    setTheme("dark");
    expect(localStorage.getItem("weeber_theme")).toBe("dark");
    expect(currentTheme()).toBe("dark");
  });

  it("toggles the theme correctly", () => {
    setTheme("light");
    toggleTheme();
    expect(currentTheme()).toBe("dark");
    toggleTheme();
    expect(currentTheme()).toBe("light");
  });

  it("removes storage value when set to null", () => {
    setTheme("dark");
    setTheme(null);
    expect(localStorage.getItem("weeber_theme")).toBeNull();
  });
});
