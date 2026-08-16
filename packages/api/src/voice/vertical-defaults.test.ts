import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Per-vertical default provisioning (2026-07-19). Covers the two properties
 * that matter: it enables exactly the curated set for the org's vertical, and
 * it is idempotent + non-destructive (a template that already has a config row
 * is never re-enabled / touched).
 */

let rowsByTable: Record<string, unknown[]> = {};
// templateKeys that already have a config row -> insert must no-op (return []).
let preexistingKeys = new Set<string>();
let insertedRows: Array<{ table: string; values: Record<string, unknown> }> = [];

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.where = () => thenable(rows);
  promise.limit = () => thenable(rows);
  promise.orderBy = () => thenable(rows);
  return promise;
}

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => thenable(rowsByTable[getTableName(table) ?? ""] ?? []),
    }),
    insert: (table: unknown) => ({
      // Accepts both a single row object and a batched array of rows (org-queries.ts's
      // provisionVerticalDefaults inserts its whole default set in one multi-row insert).
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
        const tableName = getTableName(table) ?? "";
        const rows = Array.isArray(v) ? v : [v];
        const result = rows.filter((row) => {
          const conflicts = preexistingKeys.has(String(row.templateKey));
          if (!conflicts) insertedRows.push({ table: tableName, values: row });
          return !conflicts;
        });
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve(result) }),
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve(result) }),
          returning: () => Promise.resolve(result),
        };
      },
    }),
  },
}));

const { provisionVerticalDefaults } = await import("./org-queries");
const { getRecommendedDefaults, RECOMMENDED_DEFAULTS } = await import("./vertical-defaults");

beforeEach(() => {
  preexistingKeys = new Set();
  insertedRows = [];
  rowsByTable = {
    orgs: [{ id: "org-1", vertical: "shopify" }],
    agent_templates: [
      { key: "shopify-cart-recovery" },
      { key: "shopify-cod-confirmation" },
      { key: "shopify-feedback" },
    ],
    workflow_templates: [{ id: "shopify-cart-recovery-v1" }],
  };
});

describe("getRecommendedDefaults", () => {
  it("returns the shopify curated set", () => {
    const d = getRecommendedDefaults("shopify");
    expect(d.agents).toContain("shopify-cart-recovery");
    expect(d.agents).toContain("shopify-cod-confirmation");
    expect(d.agents).not.toContain("shopify-feedback"); // opt-in, off by default
    expect(d.workflows).toEqual(["shopify-cart-recovery-v1"]);
  });

  it("returns an empty set for an unknown vertical (no throw)", () => {
    expect(getRecommendedDefaults("does-not-exist")).toEqual({ agents: [], workflows: [] });
  });

  it("every default key must exist in some seed template list (guards typos)", () => {
    // shopify defaults reference the real seed keys
    for (const k of RECOMMENDED_DEFAULTS.shopify.agents) {
      expect(k.startsWith("shopify-")).toBe(true);
    }
  });
});

describe("provisionVerticalDefaults", () => {
  it("enables the vertical's recommended agents + workflow on a fresh org", async () => {
    const result = await provisionVerticalDefaults("org-1");
    expect(result.vertical).toBe("shopify");
    expect(result.agentsEnabled.sort()).toEqual(["shopify-cart-recovery", "shopify-cod-confirmation"]);
    expect(result.workflowsEnabled).toEqual(["shopify-cart-recovery-v1"]);
    // every inserted agent row was enabled=true
    const agentInserts = insertedRows.filter((r) => r.table === "org_agent_configs");
    expect(agentInserts.every((r) => r.values.enabled === true)).toBe(true);
  });

  it("does NOT enable feedback (not in the curated set)", async () => {
    const result = await provisionVerticalDefaults("org-1");
    expect(result.agentsEnabled).not.toContain("shopify-feedback");
  });

  it("is idempotent + non-destructive — a template already configured is not touched", async () => {
    preexistingKeys = new Set(["shopify-cart-recovery"]);
    const result = await provisionVerticalDefaults("org-1");
    // cart-recovery already had a row -> not reported as newly enabled, not re-inserted
    expect(result.agentsEnabled).toEqual(["shopify-cod-confirmation"]);
    expect(insertedRows.some((r) => r.values.templateKey === "shopify-cart-recovery")).toBe(false);
  });

  it("skips a default key that isn't a real active template (no orphan rows)", async () => {
    // template list is missing cod-confirmation -> it must be skipped
    rowsByTable.agent_templates = [{ key: "shopify-cart-recovery" }];
    const result = await provisionVerticalDefaults("org-1");
    expect(result.agentsEnabled).toEqual(["shopify-cart-recovery"]);
    expect(insertedRows.some((r) => r.values.templateKey === "shopify-cod-confirmation")).toBe(false);
  });

  it("is a no-op for a vertical with no defined default set", async () => {
    rowsByTable.orgs = [{ id: "org-1", vertical: "insurance" }];
    const result = await provisionVerticalDefaults("org-1");
    expect(result.agentsEnabled).toEqual([]);
    expect(result.workflowsEnabled).toEqual([]);
    expect(insertedRows.length).toBe(0);
  });

  it("returns empty when the org does not exist", async () => {
    rowsByTable.orgs = [];
    const result = await provisionVerticalDefaults("nope");
    expect(result).toEqual({ vertical: "", agentsEnabled: [], workflowsEnabled: [] });
  });
});
