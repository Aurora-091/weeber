import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Insurance-vertical dial-time gate tests (2026-07-16,
 * docs/agent-prompts/00-insurance-regulatory-reference.md, "Platform gaps" #1/#2). Mocks `db`
 * with simple in-memory arrays for `orgs`/`org_phone_numbers`/`insurance_advisors`, and mocks
 * drizzle-orm's `eq`/`and` as plain-JS predicate builders (so `.where(predicate)` actually filters
 * instead of ignoring the condition) — same pattern as `consent-adapter.test.ts`.
 */

type OrgRow = { id: string; vertical: string; callingWindowTestModeUntil?: Date | null };
type PhoneNumberRow = { orgId: string; status: string; numberSeries: string | null };
type AdvisorRow = { orgId: string; licensedStates: string[] };

let orgRows: OrgRow[] = [];
let phoneNumberRows: PhoneNumberRow[] = [];
let advisorRows: AdvisorRow[] = [];

function getTableName(table: unknown): string | undefined {
  return (table as { __table?: string } | undefined)?.__table;
}

function thenable<T>(rows: T[], predicateHolder: { current: ((row: T) => boolean) | null }) {
  const promise = Promise.resolve(rows) as Promise<T[]> & Record<string, unknown>;
  promise.where = (predicate: (row: T) => boolean) => {
    predicateHolder.current = predicate;
    const filtered = rows.filter(predicate);
    return thenableFiltered(filtered);
  };
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
        if (name === "orgs") return thenable(orgRows, { current: null });
        if (name === "org_phone_numbers") return thenable(phoneNumberRows, { current: null });
        if (name === "insurance_advisors") return thenable(advisorRows, { current: null });
        return thenable([], { current: null });
      },
    }),
  },
}));

// The real code builds drizzle `and(eq(col, val), eq(col2, val2))` condition objects — mock
// those as plain-JS predicate-function closures instead, so the fake `.where()` above (which
// expects a predicate function) can evaluate them directly without a real SQL engine.
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
  return { eq, and };
});

// Marked with a plain `__table` string instead of relying on drizzle's real internal Symbol (the
// mocked schema objects below aren't real pgTable() results) — the fake `from()` above dispatches
// on this marker to know which in-memory array to query, since this test (unlike
// consent-adapter.test.ts's single-table case) needs to disambiguate between three tables sharing
// the same `db.select().from()` mock.
mock.module("../../database/schema", () => ({
  orgs: {
    __table: "orgs",
    id: { name: "id" },
    vertical: { name: "vertical" },
    callingWindowTestModeUntil: { name: "calling_window_test_mode_until" },
  },
  orgPhoneNumbers: {
    __table: "org_phone_numbers",
    orgId: { name: "org_id" },
    status: { name: "status" },
    numberSeries: { name: "number_series" },
  },
  insuranceAdvisors: { __table: "insurance_advisors", orgId: { name: "org_id" }, licensedStates: { name: "licensed_states" } },
}));

import { checkInsuranceNumberSeriesCompliance, checkInsuranceProducerLicensing } from "./insurance-gates";

describe("checkInsuranceNumberSeriesCompliance — Platform gap #1 (India 1600-series)", () => {
  beforeEach(() => {
    orgRows = [];
    phoneNumberRows = [];
  });

  it("allows with no orgId (no org context to check against)", async () => {
    const result = await checkInsuranceNumberSeriesCompliance(undefined, "+919876543210");
    expect(result.allowed).toBe(true);
  });

  it("allows a non-Indian number regardless of vertical (the mandate is India-specific)", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance" }];
    const result = await checkInsuranceNumberSeriesCompliance("org-1", "+12125550100");
    expect(result.allowed).toBe(true);
  });

  it("allows a non-insurance org dialing India regardless of number series", async () => {
    orgRows = [{ id: "org-1", vertical: "shopify" }];
    const result = await checkInsuranceNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(true);
  });

  it("blocks an insurance org dialing India with no active 1600-series number", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance" }];
    phoneNumberRows = [{ orgId: "org-1", status: "active", numberSeries: "160" }];
    const result = await checkInsuranceNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("1600-series");
  });

  it("allows an insurance org dialing India once an active 1600-series number exists", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance" }];
    phoneNumberRows = [{ orgId: "org-1", status: "active", numberSeries: "1600" }];
    const result = await checkInsuranceNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(true);
  });

  it("does not count a released 1600-series number as compliant", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance" }];
    phoneNumberRows = [{ orgId: "org-1", status: "released", numberSeries: "1600" }];
    const result = await checkInsuranceNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(false);
  });

  it("allows with no 1600-series number while self-expiring test mode is active (demo bypass)", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance", callingWindowTestModeUntil: new Date(Date.now() + 60_000) }];
    phoneNumberRows = [];
    const result = await checkInsuranceNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(true);
  });

  it("still blocks with an expired test-mode timestamp (bypass has self-expired)", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance", callingWindowTestModeUntil: new Date(Date.now() - 60_000) }];
    phoneNumberRows = [];
    const result = await checkInsuranceNumberSeriesCompliance("org-1", "+919876543210");
    expect(result.allowed).toBe(false);
  });
});

describe("checkInsuranceProducerLicensing — Platform gap #2 (US producer state licensing)", () => {
  beforeEach(() => {
    orgRows = [];
    advisorRows = [];
  });

  it("allows with no orgId", async () => {
    const result = await checkInsuranceProducerLicensing(undefined, "+12125550100");
    expect(result.allowed).toBe(true);
  });

  it("allows a non-NANP number regardless of vertical (this rule is US-specific)", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance" }];
    const result = await checkInsuranceProducerLicensing("org-1", "+919876543210");
    expect(result.allowed).toBe(true);
  });

  it("allows a non-insurance org regardless of licensing", async () => {
    orgRows = [{ id: "org-1", vertical: "shopify" }];
    const result = await checkInsuranceProducerLicensing("org-1", "+12125550100"); // NY area code
    expect(result.allowed).toBe(true);
  });

  it("blocks an insurance org with no advisor licensed in the resolved state", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance" }];
    advisorRows = [{ orgId: "org-1", licensedStates: ["CA"] }];
    const result = await checkInsuranceProducerLicensing("org-1", "+12125550100"); // 212 -> NY
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("NY");
  });

  it("allows once an advisor licensed in the resolved state exists", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance" }];
    advisorRows = [{ orgId: "org-1", licensedStates: ["NY", "NJ"] }];
    const result = await checkInsuranceProducerLicensing("org-1", "+12125550100"); // 212 -> NY
    expect(result.allowed).toBe(true);
  });

  it("allows (fails open) when the area code doesn't resolve to a known state", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance" }];
    advisorRows = [{ orgId: "org-1", licensedStates: ["CA"] }];
    const result = await checkInsuranceProducerLicensing("org-1", "+19995550100"); // unmapped area code
    expect(result.allowed).toBe(true);
  });

  it("allows an unlicensed org while self-expiring test mode is active (demo bypass)", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance", callingWindowTestModeUntil: new Date(Date.now() + 60_000) }];
    advisorRows = [{ orgId: "org-1", licensedStates: ["CA"] }];
    const result = await checkInsuranceProducerLicensing("org-1", "+12125550100"); // 212 -> NY, not licensed
    expect(result.allowed).toBe(true);
  });

  it("still blocks with an expired test-mode timestamp (bypass has self-expired)", async () => {
    orgRows = [{ id: "org-1", vertical: "insurance", callingWindowTestModeUntil: new Date(Date.now() - 60_000) }];
    advisorRows = [{ orgId: "org-1", licensedStates: ["CA"] }];
    const result = await checkInsuranceProducerLicensing("org-1", "+12125550100"); // 212 -> NY, not licensed
    expect(result.allowed).toBe(false);
  });
});
