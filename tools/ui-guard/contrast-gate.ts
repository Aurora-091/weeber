#!/usr/bin/env bun
/**
 * Contrast gate — fails CI when any declared token pair drops below its floor.
 *
 * WHY THIS EXISTS
 * The single widest accessibility bug found in the UI audit was `--input:
 * var(--border)` measuring 1.37:1 in light mode and 1.57:1 in dark. Every text
 * field, select and textarea on both product surfaces had a functionally
 * invisible boundary, on ~40 pages, for as long as the token existed. Nothing
 * in the toolchain could have caught it: it is a valid CSS value, it typechecks,
 * it lints, and it renders. Only measurement catches it.
 *
 * HOW IT WORKS
 * `tools/ui-guard/tokens.json` declares pairs by CSS CUSTOM PROPERTY NAME. This script
 * resolves them against the real `.theme-weeber` / `.theme-weeber.dark` blocks
 * in styles.css (following var() indirection), then shells out to
 * `tools/ui-guard/contrast.py` for the maths. The stylesheet stays the single source of
 * truth — edit a token there and the gate re-measures it here automatically.
 *
 * The colour maths deliberately lives in contrast.py and is NOT reimplemented
 * here. One implementation, used by both the gate and by hand during design
 * work, so a value can never pass the gate and fail a manual check.
 *
 * Usage:
 *   bun run contrast:gate            # table + exit 1 on any failure
 *   bun run contrast:gate --json     # machine-readable, for CI artifacts
 *
 * Exit codes: 0 all pairs at or above floor · 1 one or more failures · 2 gate
 * itself is broken (missing file, unresolvable token, contrast.py absent).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = resolve(HERE, "../..");
const TOKENS_PATH = resolve(HERE, "tokens.json");
const CONTRAST_PY = resolve(HERE, "contrast.py");
const JSON_OUT = process.argv.includes("--json");

type Pair = { label: string; fg: string; bg: string; floor: number };
type TokensFile = {
  cssFile: string;
  scopes: Record<string, string>;
  pairs: Pair[];
};

function die(msg: string): never {
  console.error(`contrast-gate: ${msg}`);
  process.exit(2);
}

/**
 * Extract `--token: value;` declarations from a specific CSS selector block.
 *
 * Brace-counted rather than regex-to-closing-brace, because `.theme-weeber`
 * contains nested at-rules and the naive `\{([^}]*)\}` would stop at the first
 * inner `}` and silently return a partial token map — which would make the gate
 * report a missing token instead of the real value. Matches the selector only
 * when it stands alone (not as a prefix of a longer compound selector), so
 * `.theme-weeber` does not accidentally match `.theme-weeber.dark`.
 */
function extractBlock(css: string, selector: string): Record<string, string> {
  const needle = new RegExp(
    `(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`,
    "m",
  );
  const m = needle.exec(css);
  if (!m) die(`selector '${selector}' not found in stylesheet`);

  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }

  const body = css.slice(start, i - 1);
  const tokens: Record<string, string> = {};
  // Top-level declarations only — skip anything inside a nested block so a
  // token defined in a media query doesn't shadow the real one.
  let nest = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    if (nest === 0) {
      const decl = /^(--[\w-]+)\s*:\s*([^;]+);/.exec(line);
      if (decl) tokens[decl[1]] = decl[2].trim();
    }
    nest += opens - closes;
    if (nest < 0) nest = 0;
  }
  return tokens;
}

/** Resolve var() indirection within a scope, falling back to the light scope. */
function resolveToken(
  name: string,
  scope: Record<string, string>,
  fallback: Record<string, string>,
  seen = new Set<string>(),
): string | null {
  if (seen.has(name)) die(`circular var reference at ${name}`);
  seen.add(name);

  const raw = scope[name] ?? fallback[name];
  if (raw === undefined) return null;

  const varRef = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(raw);
  if (varRef) {
    const inner = resolveToken(varRef[1], scope, fallback, seen);
    if (inner) return inner;
    return varRef[2]?.trim() ?? null;
  }
  return raw;
}

/** Ask contrast.py for the WCAG ratio of one pair. */
function measure(fg: string, bg: string): number {
  const res = spawnSync(
    "python3",
    [CONTRAST_PY, "--pair", `fg=${fg}`, `bg=${bg}`, "--ui"],
    { encoding: "utf8" },
  );
  if (res.error) die(`could not run contrast.py: ${res.error.message}`);
  const out = `${res.stdout}${res.stderr}`;
  // First "N.NN:1" on the data row is the WCAG ratio. The floor comparison is
  // done here rather than trusting contrast.py's exit code, because that code
  // applies a single floor to every pair and we need per-pair floors.
  const m = /(\d+(?:\.\d+)?):1/.exec(out);
  if (!m) die(`could not parse contrast.py output for ${fg} on ${bg}:\n${out}`);
  return Number.parseFloat(m[1]);
}

// ── main ─────────────────────────────────────────────────────────────────────

if (!existsSync(CONTRAST_PY)) die("tools/ui-guard/contrast.py is missing");
if (!existsSync(TOKENS_PATH)) die("tools/ui-guard/tokens.json is missing");

const spec: TokensFile = JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
const cssPath = resolve(REPO_ROOT, spec.cssFile);
if (!existsSync(cssPath)) die(`stylesheet not found: ${spec.cssFile}`);
const css = readFileSync(cssPath, "utf8");

const scopeTokens: Record<string, Record<string, string>> = {};
for (const [scopeName, selector] of Object.entries(spec.scopes)) {
  scopeTokens[scopeName] = extractBlock(css, selector);
}
const lightTokens = scopeTokens.light ?? {};

type Result = {
  scope: string;
  label: string;
  fg: string;
  bg: string;
  fgValue: string;
  bgValue: string;
  ratio: number;
  floor: number;
  pass: boolean;
};

const results: Result[] = [];
const unresolved: string[] = [];

for (const [scopeName, tokens] of Object.entries(scopeTokens)) {
  for (const pair of spec.pairs) {
    const fgValue = resolveToken(pair.fg, tokens, lightTokens);
    const bgValue = resolveToken(pair.bg, tokens, lightTokens);
    if (!fgValue || !bgValue) {
      unresolved.push(
        `${scopeName}: ${pair.label} — ${!fgValue ? pair.fg : pair.bg} does not resolve`,
      );
      continue;
    }
    const ratio = measure(fgValue, bgValue);
    results.push({
      scope: scopeName,
      label: pair.label,
      fg: pair.fg,
      bg: pair.bg,
      fgValue,
      bgValue,
      ratio,
      floor: pair.floor,
      pass: ratio >= pair.floor,
    });
  }
}

const failures = results.filter((r) => !r.pass);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { results, unresolved, failing: failures.length, total: results.length },
      null,
      2,
    ),
  );
} else {
  let currentScope = "";
  for (const r of results) {
    if (r.scope !== currentScope) {
      currentScope = r.scope;
      console.log(`\n  ${currentScope.toUpperCase()}`);
      console.log(
        `  ${"pair".padEnd(46)} ${"ratio".padStart(8)} ${"floor".padStart(6)}  verdict`,
      );
      console.log(`  ${"-".repeat(76)}`);
    }
    const mark = r.pass ? " " : "X";
    console.log(
      `${mark} ${r.label.padEnd(46)} ${`${r.ratio.toFixed(2)}:1`.padStart(8)} ${`${r.floor}:1`.padStart(6)}  ${
        r.pass ? "pass" : `FAIL  (${r.fg} = ${r.fgValue})`
      }`,
    );
  }

  if (unresolved.length > 0) {
    console.log(`\n  UNRESOLVED TOKENS (gate cannot measure these):`);
    for (const u of unresolved) console.log(`  ! ${u}`);
  }

  console.log(
    `\n  ${results.length - failures.length}/${results.length} pairs at or above floor.`,
  );
  if (failures.length > 0) {
    console.log(
      `  ${failures.length} FAILING — see ui-audit.md §A and the §D measured ramp for replacement values.`,
    );
    console.log(
      `  Note: removing hue makes borders HARDER, not easier — you lose chroma as a`,
    );
    console.log(
      `  differentiation channel and lightness must carry all of it. Measure every value.`,
    );
  }
}

// An unresolvable token means the contract and the stylesheet have diverged.
// That is a broken gate (exit 2), not a contrast failure (exit 1) — a silent
// "0 pairs checked, all green" is the one outcome this script must never print.
if (unresolved.length > 0) process.exit(2);
process.exit(failures.length > 0 ? 1 : 0);
