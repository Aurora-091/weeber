import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Product routes render inside `AppShell`'s `<main>`, and the desktop sidebar
 * (`hidden md:flex w-56`, app-shell.tsx) eats 224px of that viewport from
 * md=768 upward. A viewport breakpoint therefore lies about how much room the
 * content column actually has:
 *
 *   768px viewport → 480px of content. `sm:grid-cols-3` (fires at 640) gave
 *   three 149px cards, and the Integrations page rendered "Not connected" one
 *   letter per line with the Download button escaping its card.
 *
 * It also cannot see the sidebar collapsing (w-56 → w-[3.25rem]), which hands
 * the content column another 170px without changing the viewport at all.
 *
 * Fix (2026-08-01): `<main>` is a `@container`, and grids in product routes use
 * container variants (`@xl:`, `@4xl:`) that measure the column they live in.
 * This test keeps viewport-based grid breakpoints from creeping back.
 */

const APP_PAGES = join(import.meta.dir);
const SHELL = join(import.meta.dir, "..", "..", "components", "shell");

/** Portalled surfaces (Dialog/Sheet) render outside `<main>`, so they have no
 *  query container and must keep viewport breakpoints. */
const ALLOWED = new Set(["leads.tsx"]);

// `@`-prefixed variants are container queries — only bare viewport ones are wrong.
const VIEWPORT_GRID = /(?<![@\w-])(sm|md|lg|xl|2xl):grid-cols-\d/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

describe("product routes size their grids against the content column, not the viewport", () => {
  for (const file of [...tsxFiles(APP_PAGES), ...tsxFiles(SHELL)]) {
    const name = file.split("/").pop()!;
    if (ALLOWED.has(name)) continue;

    test(`${name} uses container variants for grid columns`, () => {
      const lines = readFileSync(file, "utf8").split("\n");
      const offenders = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => VIEWPORT_GRID.test(line))
        .map(({ line, n }) => `${name}:${n} ${line.trim()}`);

      expect(offenders).toEqual([]);
    });
  }
});

describe("AppShell establishes the query container", () => {
  test("both <main> elements are @container", () => {
    const src = readFileSync(join(SHELL, "app-shell.tsx"), "utf8");
    const mains = src.match(/<main\s+className=[\s\S]{0,300}?>/g) ?? [];
    expect(mains.length).toBe(2);
    for (const m of mains) expect(m).toContain("@container");
  });
});
