import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * General (non-insurance) India DLT number-series gate tests (2026-07-17,
 * follow-up to insurance-gates.test.ts's Platform gap #1 coverage). Same
 * mocking pattern as that file — in-memory arrays for `orgs`/
 * `org_phone_numbers`, drizzle-orm's `eq`/`and`/`inArray` mocked as plain-JS
 * predicate builders.
 */

type OrgRow = { id: string; vertical: string };
type PhoneNumberRow = { orgId: string; status: string; numberSeries: string | null };

let orgRows: OrgRow[] = [];
let phoneNumberRows: PhoneNumberRow[] = [];
let effectiveFlags: Record<string, boolean> = {};

function getTableName(table: unknown): string | undefined {
  return (table as { __table?: string } | undefined)?.__table;
}

function thenable<T>(rows: T[]) {
  const promise = Promise.resolve(rows) as Promise<T[]> & Record<string, unknown>;
  promise.where = (predicate: (row: T) => boolean) => thenableFiltered(rows.filter(predicate));
  return promise;
}

function thenableFiltered<T>(rows: T[]) {
  const promise = Promise.resolve(rows) as Promise<T[]> & Record<string, unknown>;
  promise.limit = (n: number) => Promise.resolve(rows.slice(0, n));
  return promise;
}

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        if (name === "orgs") return thenable(orgRows);
        if (name === "org_phone_numbers") return thenable(phoneNumberRows);
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
  const and =
    (...preds: Array<(row: Record<string, unknown>) => boolean>) =>
    (row: Record<string, unknown>) =>
      preds.every((p) => p(row));
  const inArray =
    (column: { name: string }, values: readonly unknown[]) =>
    (row: Record<string, unknown>) =>
      values.includes(row[toCamel(column.name)]);
  return { eq, and, inArray };
});

mock.module("../../database/schema", () => ({
  orgs: { __table: "orgs", id: { name: "id" }, vertical: { name: "vertical" } },
  orgPhoneNumbers: {
    __table: "org_phone_numbers",
    orgId: { name: "org_id" },
    status: { name: "status" },
    numberSeries: { name: "number_series" },
  },
}));

mock.module("../org-queries", () => ({
  getEffectiveFlags: async () => effectiveFlags,
}));

import { checkIndiaNumberSeriesCompliance, INDIA_NUMBER_SERIES_FLAG } from "./number-series-gate";

describe("checkIndiaNumberSeriesCompliance — general (non-insurance) India DLT gate", () => {
  beforeEach(() => {
    orgRows = [];
    phoneNumberRows = [];
    effectiveFlags = {};
  });

  it("allows with no orgId (no org context to check against)", async () => {
    const result = await checkIndiaNumberSeriesCompliance(undefined, "+919876543210");
    expect(result.allowed).toBe(true);
  });

  it("allows a non-Indian number regardless of anything else", async () => {
    orgRows = [{ id: "org-1", vertical: "shopify" }];
    effectiveFlags = { [INDIA_NUMBER_SERIES_FLAG]: true };
    const result = await checkIndiaNumberSeriesCompliance("org-1", "+12125550100");
    expect(result.allowed).toBe(true);
  });

  it("is a no-op for insurance orgs — delegated entirely to checkInsuranceNumberSeriesCompliance", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance" }];
    effectiveFlags = { [INDIA_NUMBER_SERIES_FLAG]: true };
    phoneNumberRows = []; // no registered number at all — would fail if this gate applied here
    const result = await checkIndiaNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(true);
  });

  it("allows (no-op) when the flag is off, even with an unregistered number", async () => {
    orgRows = [{ id: "org-1", vertical: "shopify" }];
    effectiveFlags = {}; // flag not set — off by default
    phoneNumberRows = [];
    const result = await checkIndiaNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(true);
  });

  it("blocks a Shopify org with no registered DLT number series, when the flag is on", async () => {
    orgRows = [{ id: "org-1", vertical: "shopify" }];
    effectiveFlags = { [INDIA_NUMBER_SERIES_FLAG]: true };
    phoneNumberRows = [{ orgId: "org-1", status: "active", numberSeries: null }];
    const result = await checkIndiaNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("no active phone number registered");
      expect(result.reason).toContain("140/160-series");
    }
  });

  it("allows a Shopify org with an active 140-series number, when the flag is on", async () => {
    orgRows = [{ id: "org-1", vertical: "shopify" }];
    effectiveFlags = { [INDIA_NUMBER_SERIES_FLAG]: true };
    phoneNumberRows = [{ orgId: "org-1", status: "active", numberSeries: "140" }];
    const result = await checkIndiaNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(true);
  });

  it("allows a Shopify org with an active 160-series number, when the flag is on", async () => {
    orgRows = [{ id: "org-1", vertical: "shopify" }];
    effectiveFlags = { [INDIA_NUMBER_SERIES_FLAG]: true };
    phoneNumberRows = [{ orgId: "org-1", status: "active", numberSeries: "160" }];
    const result = await checkIndiaNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(true);
  });

  it("ignores a matching-series number that isn't active (released)", async () => {
    orgRows = [{ id: "org-1", vertical: "shopify" }];
    effectiveFlags = { [INDIA_NUMBER_SERIES_FLAG]: true };
    phoneNumberRows = [{ orgId: "org-1", status: "released", numberSeries: "140" }];
    const result = await checkIndiaNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(false);
  });

  it("accepts a pre-fetched flags object instead of calling getEffectiveFlags itself", async () => {
    orgRows = [{ id: "org-1", vertical: "shopify" }];
    phoneNumberRows = [{ orgId: "org-1", status: "active", numberSeries: "140" }];
    // effectiveFlags module-level mock left empty on purpose — this call passes its own.
    const result = await checkIndiaNumberSeriesCompliance("org-1", "+919876543210", {
      [INDIA_NUMBER_SERIES_FLAG]: true,
    });
    expect(result.allowed).toBe(true);
  });
});
