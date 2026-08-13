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
 * KNOWN FAILURES, AND WHY THIS IS A RATCHET
 * Nine pairs fail today. A gate that goes red on its first commit has to be
 * switched off on its first commit, and a switched-off gate protects nothing —
 * the same reasoning that made the design budget a ratchet instead of a lint
 * rule. So `tokens.json` declares those nine with their measured ratio, and the
 * default mode fails only on a NEW failure or on a known one that got WORSE.
 * The list only tightens: a pair that now passes fails the gate until it is
 * deleted from the list, so the backlog cannot quietly become permanent.
 *
 * Usage:
 *   bun run contrast:gate            # ratchet — exit 1 on new/worsened failures
 *   bun run contrast:gate --strict   # ignore knownFailures; the real state today
 *   bun run contrast:gate --json     # machine-readable, for CI artifacts
 *   bun run contrast:gate --update   # prune resolved entries / record improvements
 *
 * Exit codes: 0 at or above the ratchet · 1 regression (or --strict failure) · 2
 * gate itself is broken (missing file, unresolvable token, contrast.py absent).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const TOKENS_PATH = resolve(HERE, "tokens.json");
const CONTRAST_PY = resolve(HERE, "contrast.py");
const JSON_OUT = process.argv.includes("--json");
const STRICT = process.argv.includes("--strict");
const UPDATE = process.argv.includes("--update");

/**
 * Tolerance on a known failure's recorded ratio. contrast.py is deterministic,
 * so this is not measurement noise — it is the two-decimal rounding in the
 * recorded value. Anything beyond it is a real regression.
 */
const RATIO_EPSILON = 0.01;

type Pair = { label: string; fg: string; bg: string; floor: number };
type KnownFailure = { scope: string; label: string; ratio: number; phase: string; why: string };
type TokensFile = {
  cssFile: string;
  scopes: Record<string, string>;
  pairs: Pair[];
  knownFailures?: KnownFailure[];
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
const PYTHON_CMD = process.platform === "win32" ? "python" : "python3";

function measure(fg: string, bg: string): number {
  const res = spawnSync(
    PYTHON_CMD,
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

// ── ratchet ──────────────────────────────────────────────────────────────────

const known = new Map<string, KnownFailure>(
  (spec.knownFailures ?? []).map((k) => [`${k.scope}\u0000${k.label}`, k]),
);
const key = (r: Result) => `${r.scope}\u0000${r.label}`;

/** A failure nobody has declared. This is the case the gate exists to catch. */
const newFailures = failures.filter((r) => !known.has(key(r)));

/** A declared failure that measures worse than it did when it was recorded. */
const worsened = failures.filter((r) => {
  const k = known.get(key(r));
  return k !== undefined && r.ratio < k.ratio - RATIO_EPSILON;
});

/**
 * A declared failure that now passes. Fails the gate on purpose: leaving a fixed
 * pair on the list means the next real regression on it would be excused. One
 * line to delete, or run --update.
 */
const resolved = results.filter((r) => r.pass && known.has(key(r)));

/** Declared failures that improved but still fail — --update records the gain. */
const improved = failures.filter((r) => {
  const k = known.get(key(r));
  return k !== undefined && r.ratio > k.ratio + RATIO_EPSILON;
});

/** A list entry with no matching measured pair — the list has gone stale. */
const measuredKeys = new Set(results.map(key));
const orphaned = [...known.values()].filter(
  (k) => !measuredKeys.has(`${k.scope}\u0000${k.label}`),
);

if (UPDATE) {
  const remaining = (spec.knownFailures ?? [])
    .filter((k) => {
      const hit = results.find((r) => r.scope === k.scope && r.label === k.label);
      return hit !== undefined && !hit.pass;
    })
    .map((k) => {
      const hit = results.find((r) => r.scope === k.scope && r.label === k.label)!;
      // Only ever tighten. A worsened ratio is a regression to fix, not a new
      // baseline to accept — recording it would let the gate ratchet backwards.
      return hit.ratio > k.ratio ? { ...k, ratio: hit.ratio } : k;
    });
  const next = { ...spec, knownFailures: remaining };
  writeFileSync(TOKENS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `contrast-gate: knownFailures ${spec.knownFailures?.length ?? 0} -> ${remaining.length}` +
      `${improved.length > 0 ? ` (${improved.length} improved ratio recorded)` : ""}`,
  );
  process.exit(0);
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        results,
        unresolved,
        failing: failures.length,
        total: results.length,
        strict: STRICT,
        ratchet: {
          known: known.size,
          newFailures: newFailures.map((r) => `${r.scope}: ${r.label}`),
          worsened: worsened.map((r) => `${r.scope}: ${r.label}`),
          resolved: resolved.map((r) => `${r.scope}: ${r.label}`),
          improved: improved.map((r) => `${r.scope}: ${r.label}`),
          orphaned: orphaned.map((k) => `${k.scope}: ${k.label}`),
        },
      },
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

  if (STRICT) {
    if (failures.length > 0) {
      console.log(
        `  ${failures.length} FAILING (--strict: knownFailures ignored) — see ui-audit.md §A`,
      );
      console.log(
        `  and the §D measured ramp for replacement values. Note that removing hue makes`,
      );
      console.log(
        `  borders HARDER, not easier: you lose chroma as a differentiation channel and`,
      );
      console.log(`  lightness must carry all of it. Measure every value.`);
    }
  } else {
    const declared = failures.length - newFailures.length;
    console.log(
      `  ratchet: ${declared} of ${failures.length} failures are declared in knownFailures (Phase B backlog).`,
    );
    for (const r of newFailures) {
      console.log(
        `  NEW FAILURE  ${r.scope}: ${r.label} — ${r.ratio.toFixed(2)}:1 (floor ${r.floor}:1, ${r.fg} = ${r.fgValue})`,
      );
    }
    for (const r of worsened) {
      const k = known.get(key(r))!;
      console.log(
        `  WORSENED     ${r.scope}: ${r.label} — ${k.ratio.toFixed(2)}:1 -> ${r.ratio.toFixed(2)}:1`,
      );
    }
    for (const r of resolved) {
      console.log(
        `  RESOLVED     ${r.scope}: ${r.label} now ${r.ratio.toFixed(2)}:1 — delete it from`,
      );
      console.log(
        `               tokens.json knownFailures (or run --update). Leaving it there would`,
      );
      console.log(`               excuse the next real regression on this pair.`);
    }
    for (const k of orphaned) {
      console.log(
        `  STALE ENTRY  ${k.scope}: ${k.label} is in knownFailures but no such pair is measured.`,
      );
    }
    if (improved.length > 0) {
      console.log(
        `  ${improved.length} declared failure(s) improved but still fail — run --update to record.`,
      );
    }
  }
}

// An unresolvable token means the contract and the stylesheet have diverged.
// That is a broken gate (exit 2), not a contrast failure (exit 1) — a silent
// "0 pairs checked, all green" is the one outcome this script must never print.
if (unresolved.length > 0) process.exit(2);

// A stale knownFailures entry is also a broken contract, not a design problem:
// the label it excuses no longer exists, so it is silently excusing nothing.
if (orphaned.length > 0) process.exit(2);

if (STRICT) process.exit(failures.length > 0 ? 1 : 0);
process.exit(newFailures.length + worsened.length + resolved.length > 0 ? 1 : 0);
