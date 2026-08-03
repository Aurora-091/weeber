import { resetRouteResults } from "./_a11y-report";

/**
 * Runs once, in the main process, before any worker starts. Drops the previous
 * run's per-route results so a route that was deleted or renamed cannot linger
 * in the merged artifact.
 *
 * No-op for a visual-only run.
 */
export default async function globalSetup() {
  resetRouteResults();
}
