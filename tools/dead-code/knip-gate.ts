#!/usr/bin/env bun
/**
 * Dead-code reachability gate — a RATCHET over `tools/dead-code/knip-baseline.json`.
 *
 * WHY THIS EXISTS
 * This repo had no reachability detection of any kind: oxlint runs
 * `categories.correctness` only, which is per-file, and no package.json declared
 * knip / ts-prune / unimported / depcheck / madge. The cost of that gap is
 * measurable, not theoretical: 8 of ADRs 073-088 are the same defect class —
 * code written, documented, unit-tested, and never wired to a caller. ADR-073
 * (`syncNumberWebhooksForOrg`, zero callers) and ADR-088 (`findProhibitedCapture`,
 * zero callers) are the identical bug found three days apart, both times by a
 * human happening to run `rg`. A unit test cannot catch it: the test imports the
 * function directly, so the export is "used" from the test's point of view and
 * dead from production's. Reachability is the only check that sees the difference.
 *
 * WHY A RATCHET AND NOT A BINARY GATE
 * Same reasoning as tools/ui-guard/design-guard.ts. The baseline is 61 findings.
 * A pass/fail gate would have to be switched off on its first run and would never
 * come back on. This one fails on any finding that is NOT in the baseline, so
 * pre-existing debt stays visible without blocking, and NEW dead code blocks.
 *
 * WHY IT MATCHES ON identity, NOT ON LINE NUMBERS
 * A finding is keyed `category:file#name`. Line/column are recorded for humans
 * only. Moving a dead export down a file must not turn the gate red.
 *
 * WHY `knip-bun` AND NOT `knip`
 * knip's node build allocates through oxc-parser's raw-transfer buffer and dies
 * on a small machine: `RangeError: Array buffer allocation failed` at
 * oxc-parser/src-js/raw-transfer/common.js:294 on a 4 GB / 2-core box. The bun
 * build has no such step. Pinning `knip-bun` here also means CI and a laptop
 * produce the same numbers, which is the whole point of a recorded baseline.
 *
 * Usage:
 *   bun run knip:gate            # table; exit 1 if a NEW finding appeared
 *   bun run knip:gate --json     # machine-readable
 *   bun run knip:gate --update   # rewrite the baseline to current state (commit it)
 *
 * Exit: 0 no new findings · 1 new findings · 2 the gate itself is broken.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";


const REPO_ROOT = resolve(import.meta.dir, "../..");
const BASELINE_PATH = resolve(import.meta.dir, "knip-baseline.json");
const JSON_OUT = process.argv.includes("--json");
const UPDATE = process.argv.includes("--update");

function die(msg: string): never {
  console.error(`knip-gate: ${msg}`);
  process.exit(2);
}

/**
 * Categories knip reports per file. Every one is enforced, including the
 * dependency ones whose baseline is empty — an unused or unlisted dependency is
 * cheap to fix the day it appears and expensive a year later.
 */
const CATEGORIES = [
  "files",
  "exports",
  "types",
  "duplicates",
  "enumMembers",
  "namespaceMembers",
  "dependencies",
  "devDependencies",
  "optionalPeerDependencies",
  "unlisted",
  "unresolved",
  "binaries",
] as const;
type Category = (typeof CATEGORIES)[number];

type Finding = { key: string; category: Category; file: string; name: string; line?: number };

function runKnip(): unknown {
  const res = Bun.spawnSync({
    cmd: ["bun", "x", "knip-bun", "--no-progress", "--reporter", "json"],
    cwd: REPO_ROOT,
  });
  if (!res.success && res.exitCode === null) {
    die("could not run knip-bun: process failed to start");
  }
  const out = (res.stdout?.toString() ?? "").trim();
  if (!out.startsWith("{")) {
    die(`knip-bun produced no JSON (exit ${res.exitCode}).\n${(res.stderr?.toString() ?? "").slice(0, 2000)}`);
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    die(`knip-bun JSON was unparseable: ${(e as Error).message}`);
  }
}

function collect(raw: unknown): Finding[] {
  const issues = (raw as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) die("knip JSON had no `issues` array — reporter shape changed");
  const found: Finding[] = [];
  for (const issue of issues as Record<string, unknown>[]) {
    const file = String(issue.file ?? "");
    for (const category of CATEGORIES) {
      const items = issue[category];
      if (!Array.isArray(items)) continue;
      for (const item of items as ({ name?: string; line?: number } | { name?: string }[])[]) {
        // `duplicates` reports an ARRAY of the aliases that share one symbol
        // (e.g. [PreviewHarness, default]); every other category reports a single
        // object. Flattening the group into one name keeps the key stable and
        // readable instead of recording an empty `#`.
        const group = Array.isArray(item) ? item : null;
        const name = group
          ? group.map((m) => String(m?.name ?? "?")).join("|")
          : String((item as { name?: string })?.name ?? "");
        // A whole-file finding names the file; don't repeat it in the key.
        const key = category === "files" ? `files:${file}` : `${category}:${file}#${name}`;
        found.push({ key, category, file, name, line: group ? group[0]?.line : (item as { line?: number })?.line });
      }
    }
  }
  // Stable order so --update produces a reviewable diff, not a reshuffle.
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

type Baseline = { $comment?: unknown; recordedAt?: string; recordedOn?: string; known: string[] };

function readBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    if (UPDATE) return { known: [] };
    die(`baseline missing at ${BASELINE_PATH} — run with --update to create it`);
  }
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    if (!Array.isArray(parsed.known)) die("baseline has no `known` array");
    return parsed;
  } catch (e) {
    die(`baseline unreadable: ${(e as Error).message}`);
  }
}

const findings = collect(runKnip());
const baseline = readBaseline();
const known = new Set(baseline.known);
const currentKeys = new Set(findings.map((f) => f.key));

const added = findings.filter((f) => !known.has(f.key));
const removed = [...known].filter((k) => !currentKeys.has(k)).sort();

if (UPDATE) {
  const next: Baseline = {
    $comment: (baseline.$comment as unknown) ?? undefined,
    recordedAt: new Date().toISOString().slice(0, 10),
    recordedOn: baseline.recordedOn,
    known: findings.map((f) => f.key),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `knip-gate: baseline rewritten — ${findings.length} known findings ` +
      `(+${added.length} / -${removed.length}). Commit tools/dead-code/knip-baseline.json.`,
  );
  process.exit(0);
}

const byCategory = new Map<string, number>();
for (const f of findings) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        total: findings.length,
        baseline: known.size,
        byCategory: Object.fromEntries([...byCategory].sort()),
        added,
        removed,
      },
      null,
      2,
    ),
  );
  process.exit(added.length > 0 ? 1 : 0);
}

console.log("knip dead-code ratchet");
console.log(`  baseline: ${known.size} known findings · current: ${findings.length}`);
for (const [category, count] of [...byCategory].sort()) {
  console.log(`  ${category.padEnd(26)} ${String(count).padStart(4)}`);
}

if (removed.length > 0) {
  console.log(`\n${removed.length} baseline finding(s) are gone — nice. Lower the baseline:`);
  for (const key of removed.slice(0, 20)) console.log(`  - ${key}`);
  if (removed.length > 20) console.log(`  … ${removed.length - 20} more`);
  console.log("  run: bun run knip:gate --update   (and commit the baseline)");
}

if (added.length === 0) {
  console.log("\nOK — no dead code outside the baseline.");
  process.exit(0);
}

console.error(`\nFAIL — ${added.length} finding(s) not in the baseline:`);
for (const f of added) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  console.error(`  ${f.category.padEnd(18)} ${f.name || f.file}  (${where})`);
}
console.error(
  "\nEither wire it to a caller / delete it, or — if it is genuinely reachable —\n" +
    "fix knip.json so knip can see the reference. Do NOT add it to the baseline to\n" +
    "make CI pass: the baseline is allowed to shrink, and that edit is the one thing\n" +
    "this gate exists to make visible in review.",
);
process.exit(1);
