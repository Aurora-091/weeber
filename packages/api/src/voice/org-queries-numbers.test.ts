import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * C2b — assignPhoneNumberToAgent org-scoping. A phoneNumberId is a plain
 * integer FK, so nothing about the shape of the request stops a caller from
 * passing another org's id; the ownership check inside the function is the
 * only thing that does. This covers that it's actually enforced, not just
 * documented.
 */

let mockPhoneNumberRows: { id: number }[] = [];
let insertedValues: Record<string, unknown> | undefined;
let conflictSet: Record<string, unknown> | undefined;

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => (getTableName(table) === "org_phone_numbers" ? mockPhoneNumberRows : []),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertedValues = values;
        return {
          onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
            conflictSet = set;
            return Promise.resolve();
          },
        };
      },
    }),
  },
}));

const { assignPhoneNumberToAgent } = await import("./org-queries");

describe("assignPhoneNumberToAgent — C2b org-scoping", () => {
  beforeEach(() => {
    mockPhoneNumberRows = [];
    insertedValues = undefined;
    conflictSet = undefined;
  });

  it("assigns a number that the ownership check confirms belongs to this org and is active", async () => {
    mockPhoneNumberRows = [{ id: 7 }];
    const result = await assignPhoneNumberToAgent("org-1", "cart-recovery", 7);
    expect(result.ok).toBe(true);
    expect(insertedValues?.phoneNumberId).toBe(7);
    expect(conflictSet?.phoneNumberId).toBe(7);
  });

  it("rejects assigning a phoneNumberId that doesn't resolve to an active row owned by this org", async () => {
    // Ownership check (org_phone_numbers WHERE id=X AND orgId=callingOrg AND status='active')
    // finds nothing — either the id belongs to a different org, or it's released.
    mockPhoneNumberRows = [];
    const result = await assignPhoneNumberToAgent("org-1", "cart-recovery", 999);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not belong|not active/i);
    expect(insertedValues).toBeUndefined();
  });

  it("allows unassigning (phoneNumberId=null) without an ownership lookup", async () => {
    const result = await assignPhoneNumberToAgent("org-1", "cart-recovery", null);
    expect(result.ok).toBe(true);
    expect(insertedValues?.phoneNumberId).toBeNull();
  });
});
