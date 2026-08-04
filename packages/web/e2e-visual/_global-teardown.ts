import { aggregateRouteResults } from "./_a11y-report";

/**
 * Runs once, in the main process, after every worker has exited — which is the
 * only place the full run's results are visible. `test.afterAll` fires per
 * worker and cannot do this job; see _a11y-report.ts.
 *
 * No-op for a visual-only run.
 */
export default async function globalTeardown() {
  aggregateRouteResults();
}
