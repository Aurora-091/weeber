import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Aggregation for the a11y baseline artifact.
 *
 * WHY THIS IS NOT JUST AN `afterAll`
 * The obvious implementation — push each route's result into a module-level
 * array and write the file in `test.afterAll` — is silently wrong under
 * Playwright. Specs run in worker processes, each worker gets its OWN module
 * instance, and `afterAll` fires once PER WORKER. Every worker then writes the
 * same path and the last one wins, so the artifact holds one worker's slice
 * instead of the run. It looks correct whenever a run happens to fit in a single
 * worker, which is exactly how it survived being written.
 *
 * So: each test writes its own file, and globalTeardown (which runs once, in the
 * main process, after every worker has exited) merges them.
 */

const OUT_DIR = resolve(import.meta.dirname, "..", "a11y-out");
const ROUTE_DIR = resolve(OUT_DIR, "routes");

export type RouteResult = {
  route: string;
  violations: number;
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
  /**
   * Number of axe rules that were APPLICABLE to this page. The honesty check: a
   * route that failed to mount reports 0 violations, which is indistinguishable
   * from a clean page until you also look at how much axe had to work with.
   */
  rulesApplied: number;
  rules: string[];
};

/** Called from a test. One file per route — no shared state, worker-safe. */
export function writeRouteResult(result: RouteResult) {
  mkdirSync(ROUTE_DIR, { recursive: true });
  const safe = result.route.replace(/[^a-z0-9-]/gi, "_");
  writeFileSync(resolve(ROUTE_DIR, `${safe}.json`), JSON.stringify(result) + "\n");
}

/** globalSetup: drop results from the previous run so nothing stale merges in. */
export function resetRouteResults() {
  rmSync(ROUTE_DIR, { recursive: true, force: true });
}

/** globalTeardown: merge every route file into the reviewable artifact. */
export function aggregateRouteResults() {
  let files: string[];
  try {
    files = readdirSync(ROUTE_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return; // visual-only run — nothing to aggregate, and that is not an error.
  }
  if (files.length === 0) return;

  const routes: RouteResult[] = files
    .map((f) => JSON.parse(readFileSync(resolve(ROUTE_DIR, f), "utf8")) as RouteResult)
    .sort((a, b) => a.route.localeCompare(b.route));

  const total = routes.reduce((n, r) => n + r.violations, 0);
  const minApplied = routes.reduce((n, r) => Math.min(n, r.rulesApplied), Infinity);

  writeFileSync(
    resolve(OUT_DIR, "a11y-baseline.json"),
    JSON.stringify({ totalViolations: total, routeCount: routes.length, routes }, null, 2) + "\n",
  );

  // Printed as well as written, so the number is in the CI log without opening
  // the artifact.
  console.log(`\na11y baseline — ${total} violations across ${routes.length} routes`);
  console.log(`lowest rulesApplied on any route: ${minApplied}`);
  for (const r of routes) {
    if (r.violations === 0) continue;
    console.log(
      `  ${r.route.padEnd(22)} ${String(r.violations).padStart(3)}  ` +
        `(crit ${r.critical}, serious ${r.serious})  ${r.rules.join(", ")}`,
    );
  }
}
