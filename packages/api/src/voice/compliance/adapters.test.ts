import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * D2 regression test (audit #01) — before this fix, `callerMemory` deletion
 * in `eraseOrgDataForPhoneNumber` was scoped by `phoneNumber` only, so a
 * GDPR erasure request from one org would silently delete another org's
 * memory of the same phone number too. This test asserts the `callerMemory`
 * delete is scoped by *both* `orgId` and `phoneNumber` — i.e. erasing for
 * "org-a" must never touch a row belonging to "org-b", even for the exact
 * same phone number.
 */

let mockDeletes: Array<{ tableName: string | undefined; sql: string }> = [];

function getTableName(table: any): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? table[sym] : undefined;
}

/** Safe stringify for drizzle's SQL condition objects, which contain cyclic
 * refs (query builder <-> table <-> column back-references) that plain
 * `JSON.stringify` can't handle. Drops anything already seen instead of
 * throwing — good enough to assert on which column names appear. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return undefined;
      seen.add(val);
    }
    return val;
  });
}

mock.module("../../database", () => {
  return {
    db: {
      delete: (table: any) => {
        const tableName = getTableName(table);
        return {
          where: (condition: any) => {
            // Stringify the drizzle SQL condition tree so we can assert on
            // which columns it actually filters by, without needing a real
            // Postgres connection.
            mockDeletes.push({ tableName, sql: safeStringify(condition) });
            return { returning: () => [] };
          },
        };
      },
    },
  };
});

import { eraseOrgDataForPhoneNumber } from "./adapters";

describe("eraseOrgDataForPhoneNumber — D2 org-scoping regression", () => {
  beforeEach(() => {
    mockDeletes = [];
  });

  it("scopes the caller_memory delete by orgId, not just phoneNumber", async () => {
    await eraseOrgDataForPhoneNumber("org-a", "+15555555555");

    const callerMemoryDelete = mockDeletes.find((d) => d.tableName === "caller_memory");
    expect(callerMemoryDelete).toBeDefined();
    // The condition tree must reference the org_id column (not just phone_number) —
    // catches a regression back to the old phoneNumber-only WHERE clause.
    expect(callerMemoryDelete!.sql).toContain("org_id");
    expect(callerMemoryDelete!.sql).toContain("phone_number");
  });

  it("issues separate erasure calls per org, never combining two orgs' conditions", async () => {
    await eraseOrgDataForPhoneNumber("org-a", "+15555555555");
    const orgADelete = mockDeletes.find((d) => d.tableName === "caller_memory");

    mockDeletes = [];
    await eraseOrgDataForPhoneNumber("org-b", "+15555555555");
    const orgBDelete = mockDeletes.find((d) => d.tableName === "caller_memory");

    // Same phone number, different org — the generated WHERE clauses must
    // differ (each bound to its own orgId param), proving org-b's erasure
    // request cannot be satisfied by a query shaped to match org-a's rows
    // and vice versa.
    expect(orgADelete!.sql).not.toBe(orgBDelete!.sql);
  });
});
