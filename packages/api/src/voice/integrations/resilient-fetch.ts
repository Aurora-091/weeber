/**
 * Shared resilience wrapper for every external integration call (CRM, calendar,
 * anything that reaches out to a third-party API mid-call). A live phone call
 * cannot afford to stall waiting on a slow or dead API, and a broken
 * integration must never crash the call or the agent turn that triggered it —
 * it should fail fast, fail quietly, and let the agent move on with a clear
 * "couldn't reach it" result the model can react to naturally.
 *
 * Three protections, composed:
 *   1. Timeout — bounds how long any single call attempt can take.
 *   2. Retry with backoff — a transient failure (network blip, 5xx) gets a
 *      couple of quick retries before giving up, not one shot.
 *   3. Circuit breaker — if an integration has failed repeatedly and recently,
 *      stop even trying for a cooldown window. This is what protects a live
 *      call from ever stalling on an integration that's *currently* down —
 *      once the breaker's open, failure is instant, no network round-trip.
 *
 * One breaker instance per integration name (see `getBreaker`) — a dead
 * HubSpot doesn't trip the breaker for Salesforce.
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

// Circuit breaker tuning: after this many consecutive failures, stop trying
// for the cooldown window below. Deliberately short — this protects a live
// call's latency budget, not a long-lived batch job; a few seconds of
// "integration unavailable" is fine, minutes of hanging turns is not.
const BREAKER_FAILURE_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;

type BreakerState = {
  consecutiveFailures: number;
  openedAt: number | null;
};

const breakers = new Map<string, BreakerState>();

function getBreaker(name: string): BreakerState {
  let state = breakers.get(name);
  if (!state) {
    state = { consecutiveFailures: 0, openedAt: null };
    breakers.set(name, state);
  }
  return state;
}

function isBreakerOpen(state: BreakerState): boolean {
  if (state.openedAt === null) return false;
  if (Date.now() - state.openedAt > BREAKER_COOLDOWN_MS) {
    // Cooldown elapsed — allow one attempt through (half-open) by resetting.
    state.openedAt = null;
    state.consecutiveFailures = 0;
    return false;
  }
  return true;
}

function recordSuccess(state: BreakerState) {
  state.consecutiveFailures = 0;
  state.openedAt = null;
}

function recordFailure(state: BreakerState) {
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD && state.openedAt === null) {
    state.openedAt = Date.now();
  }
}

export type ResilientResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "timeout" | "circuit-open" | "error"; message: string };

export type ResilientFetchOptions = {
  /** Integration name — its own circuit breaker, independent of every other integration. */
  integration: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
};

/**
 * Runs `fn` with timeout + retry + circuit-breaker protection. `fn` receives
 * an AbortSignal it must pass to `fetch` (or respect some other way) for the
 * timeout to actually cancel an in-flight request rather than just ignoring
 * its result.
 */
export async function resilientCall<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: ResilientFetchOptions,
): Promise<ResilientResult<T>> {
  const {
    integration,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  const breaker = getBreaker(integration);

  if (isBreakerOpen(breaker)) {
    return {
      ok: false,
      reason: "circuit-open",
      message: `${integration} has failed repeatedly and is temporarily skipped — will retry automatically after the cooldown window.`,
    };
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const data = await fn(controller.signal);
      clearTimeout(timeout);
      recordSuccess(breaker);
      return { ok: true, data };
    } catch (err) {
      clearTimeout(timeout);
      // Prefer checking the signal's own aborted state over the error's name/
      // type — fetch throws a real AbortError, but a caller's own promise
      // (e.g. one that listens for the 'abort' event manually) may reject
      // with a plain Error instead. Either way, if our own timeout fired,
      // this was a timeout, not a generic failure.
      const isTimeout = controller.signal.aborted;
      lastError = isTimeout ? new Error(`${integration} timed out after ${timeoutMs}ms`) : (err as Error);

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  recordFailure(breaker);
  const timedOut = lastError?.message.includes("timed out");
  return {
    ok: false,
    reason: timedOut ? "timeout" : "error",
    message: lastError?.message ?? `${integration} call failed for an unknown reason`,
  };
}

/** Test-only — resets all circuit breaker state between test files. */
export function __resetBreakersForTests() {
  breakers.clear();
}
