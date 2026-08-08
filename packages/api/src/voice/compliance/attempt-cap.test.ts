import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Florida FTSA attempt-cap gate tests (2026-07-17, closing docs/global-compliance-engine-plan.md
 * Tier 0 #5's flagged gap). Same mocking pattern as insurance-gates.test.ts — a plain in-memory
 * array for `calls`, and drizzle-orm's `eq`/`and`/`gte` mocked as plain-JS predicate builders.
 */

type CallRow = { id: number; toNumber: string; startedAt: Date };

let callRows: CallRow[] = [];

function getTableName(table: unknown): string | undefined {
  return (table as { __table?: string } | undefined)?.__table;
}

function thenable<T>(rows: T[]) {
  const promise = Promise.resolve(rows) as Promise<T[]> & Record<string, unknown>;
  promise.where = (predicate: (row: T) => boolean) => Promise.resolve(rows.filter(predicate));
  return promise;
}

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        if (name === "calls") return thenable(callRows);
        return thenable([]);
      },
    }),
  },
}));

mock.module("drizzle-orm", () => {
  function toCamel(snake: string): string {
    return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
  const eq =
    (column: { name: string }, value: unknown) =>
    (row: Record<string, unknown>) =>
      row[toCamel(column.name)] === value;
  const gte =
    (column: { name: string }, value: Date) =>
    (row: Record<string, unknown>) =>
      (row[toCamel(column.name)] as Date).getTime() >= value.getTime();
  const and =
    (...preds: Array<(row: Record<string, unknown>) => boolean>) =>
    (row: Record<string, unknown>) =>
      preds.every((p) => p(row));
  return { eq, and, gte };
});

mock.module("../../database/schema", () => ({
  calls: { __table: "calls", toNumber: { name: "to_number" }, startedAt: { name: "started_at" } },
}));

mock.module("@weeber/compliance", () => ({
  MINI_TCPA_AREA_CODE_STATE: { "305": "FL", "407": "FL", "206": "WA", "405": "OK" },
}));

import { checkFtsaAttemptCap, FTSA_MAX_ATTEMPTS_PER_24H } from "./attempt-cap";

const NOW = new Date("2026-07-17T12:00:00Z");
const FL_NUMBER = "+13051234567"; // 305 = Florida
const WA_NUMBER = "+12061234567"; // 206 = Washington (mini-TCPA window, but NOT FTSA-capped)
const UNMAPPED_NUMBER = "+19991234567"; // no area code in the map at all

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000);
}

describe("checkFtsaAttemptCap — Florida FTSA max-3-attempts/24h cap", () => {
  beforeEach(() => {
    callRows = [];
  });

  it("allows a Florida number with zero prior calls in the last 24h", async () => {
    const result = await checkFtsaAttemptCap(FL_NUMBER, NOW);
    expect(result.allowed).toBe(true);
  });

  it("allows a Florida number with exactly 2 prior calls in the last 24h (under the cap of 3)", async () => {
    callRows = [
      { id: 1, toNumber: FL_NUMBER, startedAt: hoursAgo(1) },
      { id: 2, toNumber: FL_NUMBER, startedAt: hoursAgo(10) },
    ];
    const result = await checkFtsaAttemptCap(FL_NUMBER, NOW);
    expect(result.allowed).toBe(true);
  });

  it(`blocks a Florida number once ${FTSA_MAX_ATTEMPTS_PER_24H} prior calls exist in the last 24h`, async () => {
    callRows = [
      { id: 1, toNumber: FL_NUMBER, startedAt: hoursAgo(1) },
      { id: 2, toNumber: FL_NUMBER, startedAt: hoursAgo(10) },
      { id: 3, toNumber: FL_NUMBER, startedAt: hoursAgo(20) },
    ];
    const result = await checkFtsaAttemptCap(FL_NUMBER, NOW);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("Florida FTSA cap reached");
  });

  it("ignores a call to this same number that happened more than 24h ago — outside the rolling window", async () => {
    callRows = [
      { id: 1, toNumber: FL_NUMBER, startedAt: hoursAgo(1) },
      { id: 2, toNumber: FL_NUMBER, startedAt: hoursAgo(10) },
      { id: 3, toNumber: FL_NUMBER, startedAt: hoursAgo(25) }, // outside the window, shouldn't count
    ];
    const result = await checkFtsaAttemptCap(FL_NUMBER, NOW);
    expect(result.allowed).toBe(true);
  });

  it("never counts calls to a different recipient toward this number's cap", async () => {
    callRows = [
      { id: 1, toNumber: FL_NUMBER, startedAt: hoursAgo(1) },
      { id: 2, toNumber: "+13059999999", startedAt: hoursAgo(2) },
      { id: 3, toNumber: "+13058888888", startedAt: hoursAgo(3) },
    ];
    const result = await checkFtsaAttemptCap(FL_NUMBER, NOW);
    expect(result.allowed).toBe(true);
  });

  it("is a no-op for a non-Florida mini-TCPA state (Washington) — FTSA is Florida-specific, not applied broadly", async () => {
    callRows = [
      { id: 1, toNumber: WA_NUMBER, startedAt: hoursAgo(1) },
      { id: 2, toNumber: WA_NUMBER, startedAt: hoursAgo(2) },
      { id: 3, toNumber: WA_NUMBER, startedAt: hoursAgo(3) },
      { id: 4, toNumber: WA_NUMBER, startedAt: hoursAgo(4) },
    ];
    const result = await checkFtsaAttemptCap(WA_NUMBER, NOW);
    expect(result.allowed).toBe(true);
  });

  it("is a no-op for an unmapped/non-US area code — fails open, same convention as the rest of packs/us.ts", async () => {
    const result = await checkFtsaAttemptCap(UNMAPPED_NUMBER, NOW);
    expect(result.allowed).toBe(true);
  });
});
