import { Component, type ReactNode } from "react";

/**
 * App-wide catch-all error boundary. The existing `ChunkErrorBoundary` is
 * deliberately narrow — it only handles stale dynamic-import failures and
 * re-throws everything else. This boundary sits *outside* it and catches
 * those re-thrown runtime render errors so a bug in any page renders a
 * recoverable fallback instead of a blank white screen (the worst possible
 * failure mode during a live demo). React still logs the error to the console
 * for debugging; this only controls what the user sees.
 */
type Props = { children: ReactNode };
type State = { hasError: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    // Surface for local debugging / whatever error reporter is wired in later.
    // eslint-disable-next-line no-console
    console.error("[error-boundary] uncaught render error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">Something went wrong.</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            An unexpected error stopped this page from loading. Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
