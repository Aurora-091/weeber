import { Component, type ReactNode } from "react";

/**
 * Catches dynamic-import ("chunk load") failures from the route-level
 * React.lazy() tree (app.tsx, since the subdomain-split refactor) — audit#03
 * P2 fix. Before this, a failed chunk fetch (most commonly: a user has an old
 * tab open, a new deploy invalidates the previous build's chunk hashes, then
 * they navigate and the browser 404s trying to fetch a chunk that no longer
 * exists) white-screened the tab with an uncaught error. Now it shows a
 * "reload" prompt instead — the correct recovery action, since a hard
 * navigation fetches the current index.html and its current chunk map.
 *
 * Deliberately narrow: only recognizes the specific error shapes browsers/
 * bundlers throw for a failed dynamic import (Vite's "Failed to fetch
 * dynamically imported module", the browser-native
 * "error loading dynamically imported module", or a chunk-load TypeError) —
 * anything else re-throws to the console as a genuine bug, not silently
 * swallowed as "just reload."
 */
function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
    error.message,
  );
}

type Props = { children: ReactNode };
type State = { chunkError: boolean };

export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { chunkError: false };

  static getDerivedStateFromError(error: unknown): State | null {
    if (isChunkLoadError(error)) return { chunkError: true };
    // Not a chunk-load failure -- rethrow so it surfaces normally (React logs
    // it to the console); this boundary only exists to handle stale-chunk
    // recovery, not to be a catch-all error boundary for the whole app.
    throw error;
  }

  render() {
    if (this.state.chunkError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-muted-foreground">
            A new version of this app was deployed while you had this page open.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
