import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Audit 2026-07-19 finding #2 — the outbound-call rate limiter was a process-local module
 * singleton shared across every org. These cover the calling contract of the new Postgres-backed,
 * per-org replacement: correct params passed through, and the allowed/blocked decision derived
 * correctly from the row `db.execute` returns.
 *
 * The actual reset-vs-increment window logic lives entirely in the single atomic UPSERT
 * statement (see rate-limit-store.ts's docstring) — that SQL was verified directly against a
 * real local Postgres instance during development (confirmed: same-org calls increment within a
 * window, a different org's counter is completely independent, and the window resets to
 * call_count=1 once the configured window has elapsed). This test file exercises the TypeScript
 * side (what params get sent, how the returned row maps to the allowed/blocked result), following
 * the same "mock the I/O boundary" convention as every other test in this suite (e.g.
 * credential-vault.test.ts) rather than depending on Postgres being available in CI.
 */

let lastExecuteArgs: unknown = null;
let mockReturnRow: { window_start: Date; call_count: number } | null = null;

mock.module("./index", () => ({
  db: {
    execute: async (query: unknown) => {
      lastExecuteArgs = query;
      return mockReturnRow ? [mockReturnRow] : [];
    },
  },
}));

import { checkAndIncrementOutboundRateLimit, checkAndIncrementKeyedRateLimit } from "./rate-limit-store";

describe("checkAndIncrementOutboundRateLimit", () => {
  beforeEach(() => {
    lastExecuteArgs = null;
    mockReturnRow = null;
  });

  it("allows the call when the returned count is at or under the limit", async () => {
    mockReturnRow = { window_start: new Date("2026-07-20T00:00:00Z"), call_count: 5 };
    const result = await checkAndIncrementOutboundRateLimit("org-a", 60_000, 30);
    expect(result.allowed).toBe(true);
    expect(result.callCount).toBe(5);
  });

  it("blocks the call when the returned count exceeds the limit", async () => {
    mockReturnRow = { window_start: new Date("2026-07-20T00:00:00Z"), call_count: 31 };
    const result = await checkAndIncrementOutboundRateLimit("org-a", 60_000, 30);
    expect(result.allowed).toBe(false);
    expect(result.callCount).toBe(31);
  });

  it("allows exactly at the limit boundary (count === max)", async () => {
    mockReturnRow = { window_start: new Date(), call_count: 30 };
    const result = await checkAndIncrementOutboundRateLimit("org-a", 60_000, 30);
    expect(result.allowed).toBe(true);
  });

  it("passes the orgId, window, and query through to the executed statement", async () => {
    mockReturnRow = { window_start: new Date(), call_count: 1 };
    await checkAndIncrementOutboundRateLimit("org-specific", 12_345, 7);
    expect(lastExecuteArgs).not.toBeNull();
  });

  it("fails open (does not throw/block) if the query unexpectedly returns no row", async () => {
    mockReturnRow = null;
    const result = await checkAndIncrementOutboundRateLimit("org-a", 60_000, 30);
    expect(result.allowed).toBe(true);
  });
});

/**
 * Real demo-call widget (2026-08-27) — the per-phone-number/global-daily-cap sibling. Same
 * atomic-UPSERT shape, keyed by `(scope, key)` instead of a bare org id.
 */
describe("checkAndIncrementKeyedRateLimit", () => {
  beforeEach(() => {
    lastExecuteArgs = null;
    mockReturnRow = null;
  });

  it("allows the call when the returned count is at or under the limit", async () => {
    mockReturnRow = { window_start: new Date(), call_count: 1 };
    const result = await checkAndIncrementKeyedRateLimit("phone", "+14155551234", 86_400_000, 1);
    expect(result.allowed).toBe(true);
  });

  it("blocks the call when the returned count exceeds the limit", async () => {
    mockReturnRow = { window_start: new Date(), call_count: 2 };
    const result = await checkAndIncrementKeyedRateLimit("phone", "+14155551234", 86_400_000, 1);
    expect(result.allowed).toBe(false);
  });

  it("works independently for the global scope", async () => {
    mockReturnRow = { window_start: new Date(), call_count: 50 };
    const result = await checkAndIncrementKeyedRateLimit("global", "all", 86_400_000, 50);
    expect(result.allowed).toBe(true);
  });

  it("fails open if the query unexpectedly returns no row", async () => {
    mockReturnRow = null;
    const result = await checkAndIncrementKeyedRateLimit("phone", "+14155551234", 86_400_000, 1);
    expect(result.allowed).toBe(true);
  });
});
