import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Drizzle consent-ledger adapter tests (Global Compliance Engine Tier 0, 2026-07-16,
 * docs/global-compliance-engine-plan.md #6). Mocks `db` with a simple in-memory array standing
 * in for the `consent_records` table — good enough to assert the adapter's real logic (org
 * scoping, most-recent-record resolution, expiry/withdrawal semantics) without a live Postgres
 * connection, same style as other lightweight adapter tests in this codebase
 * (voice/routes.test.ts's `mockSelectedOrgs`).
 */

type FakeRow = {
  id: number;
  orgId: string;
  dataPrincipal: string;
  purpose: string;
  granted: boolean;
  grantedAt: Date;
  expiresAt: Date | null;
  version: string;
  channel: string;
  source: string;
  withdrawnAt: Date | null;
};

let rows: FakeRow[] = [];
let nextId = 1;

mock.module("../../database", () => {
  return {
    db: {
      insert: () => ({
        values: (v: Omit<FakeRow, "id">) => {
          rows.push({ id: nextId++, ...v });
          return Promise.resolve();
        },
      }),
      select: () => ({
        from: () => ({
          where: (predicate: (row: FakeRow) => boolean) => ({
            // Returns a real Promise (awaitable directly, as listForPrincipal does) with an
            // extra `.limit()` method attached (as mostRecentRecord's `.orderBy().limit(1)`
            // chain needs) — a genuine Promise instance rather than a custom "thenable" object,
            // so it behaves correctly either way without tripping a no-thenable lint rule.
            orderBy: () => {
              const matched = rows.filter(predicate).sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime());
              const result = Promise.resolve(matched) as Promise<FakeRow[]> & { limit: (n: number) => Promise<FakeRow[]> };
              result.limit = (n: number) => Promise.resolve(matched.slice(0, n));
              return result;
            },
          }),
        }),
      }),
      update: () => ({
        set: (patch: Partial<FakeRow>) => ({
          where: (predicate: (row: FakeRow) => boolean) => {
            const row = rows.find(predicate);
            if (row) Object.assign(row, patch);
            return Promise.resolve();
          },
        }),
      }),
    },
  };
});

// The adapter builds drizzle `and(eq(...), eq(...))` condition objects, not plain predicate
// functions — mock drizzle-orm's helpers to instead build a plain-JS predicate function closure,
// so the fake `where()` above (which expects a predicate) can evaluate them directly without a
// real SQL engine.
mock.module("drizzle-orm", () => {
  const eq = (column: { name: string }, value: unknown) => (row: FakeRow) => (row as any)[toCamel(column.name)] === value;
  const and = (...preds: Array<(row: FakeRow) => boolean>) => (row: FakeRow) => preds.every((p) => p(row));
  const desc = (column: unknown) => column;
  function toCamel(snake: string): string {
    return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
  return { eq, and, desc };
});

// Minimal fake column objects — the mocked `eq()` above only needs `.name`, matching how the
// mocked drizzle-orm helpers interpret them.
mock.module("../../database/schema", () => {
  return {
    consentRecords: {
      orgId: { name: "org_id" },
      dataPrincipal: { name: "data_principal" },
      purpose: { name: "purpose" },
      id: { name: "id" },
      grantedAt: { name: "granted_at" },
    },
  };
});

import { createConsentAdapterForOrg } from "./adapters";

describe("createConsentAdapterForOrg — Global Compliance Engine Tier 0 #6", () => {
  beforeEach(() => {
    rows = [];
    nextId = 1;
  });

  it("hasConsent is false with no grant on record", async () => {
    const adapter = createConsentAdapterForOrg("org-a");
    expect(await adapter.hasConsent("+15550001111", "marketing")).toBe(false);
  });

  it("hasConsent is true after a grant", async () => {
    const adapter = createConsentAdapterForOrg("org-a");
    await adapter.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    expect(await adapter.hasConsent("+15550001111", "marketing")).toBe(true);
  });

  it("a grant for one org never satisfies hasConsent for a different org — the real gap this factory closes", async () => {
    const orgA = createConsentAdapterForOrg("org-a");
    const orgB = createConsentAdapterForOrg("org-b");
    await orgA.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    expect(await orgA.hasConsent("+15550001111", "marketing")).toBe(true);
    expect(await orgB.hasConsent("+15550001111", "marketing")).toBe(false);
  });

  it("withdraw marks the most recent record withdrawn and hasConsent flips to false", async () => {
    const adapter = createConsentAdapterForOrg("org-a");
    await adapter.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    await adapter.withdraw("+15550001111", "marketing");
    expect(await adapter.hasConsent("+15550001111", "marketing")).toBe(false);
  });

  it("an expired grant does not satisfy hasConsent", async () => {
    const adapter = createConsentAdapterForOrg("org-a");
    await adapter.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() - 500),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    expect(await adapter.hasConsent("+15550001111", "marketing")).toBe(false);
  });

  it("listForPrincipal returns every record for that org+principal, including withdrawn ones", async () => {
    const adapter = createConsentAdapterForOrg("org-a");
    await adapter.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    await adapter.withdraw("+15550001111", "marketing");
    const history = await adapter.listForPrincipal("+15550001111");
    expect(history.length).toBe(1);
    expect(history[0]?.withdrawnAt).not.toBeNull();
  });
});
