#!/usr/bin/env bun
/**
 * Design-system drift guard — a ratchet over `tools/ui-guard/design-budget.json`.
 *
 * WHY THIS AND NOT A LINT RULE
 * oxlint has no custom-rule plugin API, so "no raw hex / no arbitrary px / no raw
 * <button> / no raw <select>" cannot be expressed as lint rules in this repo. And
 * a binary rule would be the wrong tool anyway: 365 arbitrary px values cannot be
 * removed in one commit, so a pass/fail rule would be switched off immediately and
 * would never come back on. This only ever lets a count go DOWN — it blocks new
 * drift without pretending the existing drift is already fixed.
 *
 * Usage:
 *   bun run design:guard             # table; exit 1 if any count rose
 *   bun run design:guard --json      # machine-readable
 *   bun run design:guard --update    # rewrite budget to current counts (commit it)
 *
 * Exit: 0 at or under budget · 1 a count rose · 2 the guard itself is broken.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const BUDGET_PATH = resolve(HERE, "design-budget.json");
const JSON_OUT = process.argv.includes("--json");
const UPDATE = process.argv.includes("--update");

function die(msg: string): never {
  console.error(`design-guard: ${msg}`);
  process.exit(2);
}

/**
 * WHY THIS DOES NOT SHELL OUT TO RIPGREP
 * It used to. `spawnSync("rg", ...)` worked on every dev machine and failed on
 * the very first CI run, because the ubuntu-latest runner image does not ship
 * ripgrep — and a missing binary makes spawnSync return `status: null`, so the
 * error read `rg failed for /<button/: exit undefined`. A gate that only works
 * where its author happens to have a tool installed is not a gate. Counting is
 * a dozen lines of Bun, so it now has no external dependency at all and gives
 * byte-identical numbers on any machine.
 *
 * PARITY WITH THE OLD RIPGREP BEHAVIOUR — the counts in design-budget.json were
 * measured with rg, so this must reproduce them exactly:
 *   - only *.tsx, matching the old `--glob '*.tsx'`
 *   - matching is LINE BY LINE, because rg searches a line at a time. This is
 *     load-bearing, not cosmetic: `inlineCardClone`'s `[^"]*` also matches \n in
 *     JS, so running it over whole-file text would join unrelated lines and
 *     inflate the count. Do not "simplify" this into one whole-file regex.
 *   - 'occurrences' counts every non-overlapping match (rg -o), 'files' counts
 *     files with at least one match (rg -l).
 */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

/** Every *.tsx under `dir`, as slash-separated paths relative to `dir`. */
function listTsx(dir: string, relBase = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      out.push(...listTsx(resolve(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Directory exclusions, as path fragments relative to scanRoot. Replaces rg's
 * `-g '!components/ui/**'`. Kept deliberately dumb — a real glob engine here
 * would be a second thing to distrust.
 */
function isExcluded(rel: string, exclude: string[]): boolean {
  return exclude.some((frag) => rel.startsWith(frag) || rel.includes(`/${frag}`));
}

/** Count matches of `pattern`. mode 'occurrences' = rg -o, 'files' = rg -l. */
function count(
  pattern: string,
  root: string,
  mode: "occurrences" | "files",
  exclude: string[] = [],
): number {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "g");
  } catch (err) {
    die(`invalid pattern /${pattern}/: ${(err as Error).message}`);
  }
  let total = 0;
  for (const rel of listTsx(root)) {
    if (isExcluded(rel, exclude)) continue;
    const text = readFileSync(resolve(root, rel), "utf8");
    let hits = 0;
    for (const line of text.split("\n")) {
      hits += line.match(re)?.length ?? 0;
    }
    if (mode === "files") {
      if (hits > 0) total += 1;
    } else {
      total += hits;
    }
  }
  return total;
}

if (!existsSync(BUDGET_PATH)) die("tools/ui-guard/design-budget.json is missing");
const spec = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
const root = resolve(REPO_ROOT, spec.scanRoot);
if (!existsSync(root)) die(`scanRoot not found: ${spec.scanRoot}`);

const EXCLUDE_UI = ["components/ui/"];

/**
 * Each metric is a named counter. Patterns are deliberately simple and
 * over-inclusive rather than clever — a guard that is hard to reason about gets
 * distrusted and then ignored. If a count looks wrong, reproduce it with
 * `rg -o --glob '*.tsx' -g '!components/ui/**' '<pattern>' packages/web/src/web | wc -l`
 * — the counter is a faithful reimplementation of exactly that.
 */
const METRICS: Record<string, () => number> = {
  // components/ui/ is excluded on principle — a primitive is allowed to be the
  // one place a raw element is rendered. In practice it changes nothing for these
  // two: ui/button.tsx renders `const Comp = asChild ? Slot.Root : "button"`, a
  // STRING, and ui/select.tsx is Radix, so `<button` / `<select` match zero times
  // in that directory (measured). Keeping the exclusion so the metric stays
  // honest if a primitive ever does use JSX for its own element.
  rawButton: () => count("<button", root, "occurrences", EXCLUDE_UI),
  rawSelect: () => count("<select", root, "occurrences", EXCLUDE_UI),
  arbitraryPx: () => count("\\[[0-9]+px\\]", root, "occurrences"),
  rawHex: () => count("#[0-9a-fA-F]{3,8}\\b", root, "occurrences"),
  cardLift: () => count("card-lift", root, "occurrences"),
  cardAction: () => count("card-action", root, "occurrences"),
  transitionAll: () => count("transition-all", root, "occurrences"),
  inlineCardClone: () =>
    count(
      "rounded-(lg|xl|2xl|md)[^\"]*border[^\"]*bg-",
      root,
      "files",
      EXCLUDE_UI,
    ),
};

type Row = {
  metric: string;
  current: number;
  limit: number;
  target: number;
  delta: number;
  ok: boolean;
  atTarget: boolean;
  phase: string;
};

const rows: Row[] = [];
for (const [metric, fn] of Object.entries(METRICS)) {
  const entry = spec.budget[metric];
  if (!entry) die(`metric '${metric}' has no budget entry`);
  const current = fn();
  rows.push({
    metric,
    current,
    limit: entry.limit,
    target: entry.target,
    delta: current - entry.limit,
    ok: current <= entry.limit,
    atTarget: current <= entry.target,
    phase: entry.phase,
  });
}

// Any budget key with no matching counter means the two files have diverged and
// something is going unmeasured. Fail loudly rather than silently skipping it.
for (const key of Object.keys(spec.budget)) {
  if (!(key in METRICS)) die(`budget has '${key}' but no counter implements it`);
}

if (UPDATE) {
  for (const r of rows) {
    if (r.current > spec.budget[r.metric].limit) {
      die(
        `refusing to --update: '${r.metric}' ROSE ${r.limit} -> ${r.current}. ` +
          `The budget only ratchets down. Fix the regression, or edit the limit by ` +
          `hand with a reason in the commit message so it shows up in review.`,
      );
    }
    spec.budget[r.metric].limit = r.current;
  }
  spec.recordedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(BUDGET_PATH, `${JSON.stringify(spec, null, 2)}\n`);
  console.log("design-guard: budget ratcheted down to current counts. Commit it.");
  process.exit(0);
}

const regressions = rows.filter((r) => !r.ok);

if (JSON_OUT) {
  console.log(JSON.stringify({ rows, regressions: regressions.length }, null, 2));
} else {
  console.log(
    `\n  ${"metric".padEnd(18)} ${"now".padStart(5)} ${"budget".padStart(7)} ${"target".padStart(7)}  phase  status`,
  );
  console.log(`  ${"-".repeat(64)}`);
  for (const r of rows) {
    const status = !r.ok
      ? `REGRESSED +${r.delta}`
      : r.atTarget
        ? "at target"
        : `${r.current - r.target} to go`;
    console.log(
      `${r.ok ? " " : "X"} ${r.metric.padEnd(18)} ${String(r.current).padStart(5)} ${String(r.limit).padStart(7)} ${String(r.target).padStart(7)}  ${r.phase.padEnd(5)}  ${status}`,
    );
  }
  const remaining = rows.reduce((n, r) => n + Math.max(0, r.current - r.target), 0);
  console.log(`\n  ${remaining} violations remaining above target.`);
  if (regressions.length > 0) {
    console.log(
      `  ${regressions.length} metric(s) REGRESSED. New drift was introduced — see the 'why' field`,
    );
    console.log(`  in tools/ui-guard/design-budget.json for what each metric protects.`);
  }
}

process.exit(regressions.length > 0 ? 1 : 0);
