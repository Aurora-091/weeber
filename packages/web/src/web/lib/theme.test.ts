import { describe, it, expect, beforeEach } from "bun:test";

// `localStorage` and `window.matchMedia` are provided by the happy-dom global
// DOM registered in test-setup.ts (see bunfig.toml preload). happy-dom's
// matchMedia defaults `matches` to false, so no manual mocking is needed here.
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
