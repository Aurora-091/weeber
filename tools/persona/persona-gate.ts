#!/usr/bin/env bun
/**
 * Persona size ratchet (ADR-104).
 *
 * Every character of `agent_templates.default_persona_prompt` is re-sent as
 * system-prompt text on every turn of every call. Before the runtime/authoring
 * split the seeded personas were 6,579-19,480 characters and 13-40% of that was
 * prose addressed to a maintainer, not to an agent on a call. The split removed
 * the metadata; nothing stops it growing back.
 *
 * This is a ratchet, not a limit: the budgets in `persona-budget.json` are the
 * measured sizes at the moment the split landed, and the gate fails when a file
 * goes *up*. It is deliberately not a round number like "8000 chars" — a round
 * number leaves silent headroom to grow into, which is how the personas got to
 * 19k in the first place.
 *
 * Rules of use, same as the other ratchets in this repo: to make this pass, cut
 * persona text or move maintainer prose outside the runtime markers. Do not edit
 * a budget upward. A genuinely larger persona needs an ADR saying why the
 * per-turn token cost is worth it, and the budget bumped in that same commit.
 *
 * Prompt length is not a cosmetic concern here. Long, document-shaped personas
 * are what produced reciting agents on production calls 22 and 24 — see
 * docs/decisions/adr-104-*.md.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractRuntimePersona, findRuntimeLeaks } from "../../packages/api/src/voice/persona-source";

const repoRoot = join(import.meta.dir, "../..");
const promptsDir = join(repoRoot, "docs/agent-prompts");
const budgetPath = join(import.meta.dir, "persona-budget.json");

interface Budget {
  /** Files in docs/agent-prompts that are reference material, never seeded. */
  notSeeded: string[];
  /** Measured runtime-region size per seeded file. May only go down. */
  maxRuntimeChars: Record<string, number>;
  /** Sum of the above. Kept explicit so a shuffle between files is still caught. */
  maxTotalRuntimeChars: number;
}

const budget = JSON.parse(readFileSync(budgetPath, "utf8")) as Budget;
const write = process.argv.includes("--write");

const files = readdirSync(promptsDir)
  .filter((f) => f.endsWith(".md") && !budget.notSeeded.includes(f))
  .sort();

const failures: string[] = [];
const measured: Record<string, number> = {};
let total = 0;

for (const file of files) {
  const source = readFileSync(join(promptsDir, file), "utf8");
  let runtimeChars: number;
  try {
    const extraction = extractRuntimePersona(source, file);
    runtimeChars = extraction.runtimeChars;
    const leaks = findRuntimeLeaks(extraction.runtime);
    for (const leak of leaks) failures.push(`${file}: ${leak}`);
  } catch (err) {
    failures.push(`${file}: ${(err as Error).message}`);
    continue;
  }

  measured[file] = runtimeChars;
  total += runtimeChars;

  const allowed = budget.maxRuntimeChars[file];
  if (allowed === undefined) {
    failures.push(
      `${file}: seeded prompt with no entry in tools/persona/persona-budget.json. ` +
        `Add it at its current size (${runtimeChars}) — a new persona joins the ratchet, it does not bypass it.`,
    );
  } else if (runtimeChars > allowed) {
    failures.push(
      `${file}: runtime persona grew to ${runtimeChars} chars, budget ${allowed} (+${runtimeChars - allowed}). ` +
        `Cut persona text or move maintainer prose outside the runtime markers — do not raise the budget.`,
    );
  }
}

for (const file of Object.keys(budget.maxRuntimeChars)) {
  if (!files.includes(file)) {
    failures.push(`${file}: has a budget entry but no such seeded prompt file — remove the stale entry.`);
  }
}

if (total > budget.maxTotalRuntimeChars) {
  failures.push(
    `total runtime persona size grew to ${total} chars, budget ${budget.maxTotalRuntimeChars}. ` +
      `Every character is re-sent on every turn of every call.`,
  );
}

if (write) {
  const next: Budget = {
    notSeeded: budget.notSeeded,
    maxRuntimeChars: measured,
    maxTotalRuntimeChars: total,
  };
  Bun.write(budgetPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`[persona-gate] rewrote budget from measurement: ${files.length} files, ${total} chars total.`);
  process.exit(0);
}

const headroom = budget.maxTotalRuntimeChars - total;
console.log(
  `[persona-gate] ${files.length} seeded personas, ${total} runtime chars total ` +
    `(budget ${budget.maxTotalRuntimeChars}, ${headroom} under).`,
);
for (const file of files) {
  const allowed = budget.maxRuntimeChars[file];
  console.log(`  ${file}: ${measured[file] ?? "-"}${allowed === undefined ? " (no budget)" : ` / ${allowed}`}`);
}

if (failures.length > 0) {
  console.error(`\n[persona-gate] ${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("[persona-gate] OK");
