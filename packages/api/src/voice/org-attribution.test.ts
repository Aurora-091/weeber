import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Inbound call → org attribution (org-attribution.ts). Before this existed,
 * every genuinely inbound call was persisted with `orgId: null`, which
 * silently stripped caller memory, org feature flags, the org's persona and
 * CRM sync from the call — see that file's doc comment.
 *
 * The db is mocked per-table (the established pattern in org-queries.test.ts):
 * WHERE predicates aren't interpreted, so the fixtures return every row for a
 * table and the helper's own candidate-preference / status filtering is what's
 * under test.
 */

let orgRows: { orgId: string; number: string | null }[] = [];
let phoneRows: { orgId: string; number: string; status: string }[] = [];
let selectShouldThrow = false;
const queriedTables: string[] = [];

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table) ?? "";
        queriedTables.push(name);
        return {
          where: () => {
            if (selectShouldThrow) throw new Error("db exploded");
            if (name === "orgs") return Promise.resolve(orgRows);
            if (name === "org_phone_numbers") return Promise.resolve(phoneRows);
            return Promise.resolve([]);
          },
        };
      },
    }),
  },
}));

const { resolveOrgIdForNumbers } = await import("./org-attribution");

describe("resolveOrgIdForNumbers", () => {
  beforeEach(() => {
    orgRows = [];
    phoneRows = [];
    selectShouldThrow = false;
    queriedTables.length = 0;
  });

  it("resolves the org from a provisioned number in org_phone_numbers", async () => {
    phoneRows = [{ orgId: "org-shop", number: "+15551110000", status: "active" }];
    expect(await resolveOrgIdForNumbers("+15551110000", "+919999999999")).toBe("org-shop");
  });

  it("resolves the org from the legacy orgs.outboundNumber column", async () => {
    orgRows = [{ orgId: "org-legacy", number: "+15552220000" }];
    expect(await resolveOrgIdForNumbers("+15552220000", "+919999999999")).toBe("org-legacy");
  });

  it("returns null for a number no org owns, rather than throwing", async () => {
    expect(await resolveOrgIdForNumbers("+15559998888", "+919999999999")).toBeNull();
  });

  it("ignores released numbers — the org no longer owns them", async () => {
    phoneRows = [{ orgId: "org-former", number: "+15551110000", status: "released" }];
    expect(await resolveOrgIdForNumbers("+15551110000")).toBeNull();
  });

  it("prefers an active row over a released row for the same number", async () => {
    phoneRows = [
      { orgId: "org-former", number: "+15551110000", status: "released" },
      { orgId: "org-current", number: "+15551110000", status: "active" },
    ];
    expect(await resolveOrgIdForNumbers("+15551110000")).toBe("org-current");
  });

  it("prefers the first candidate (To) over the second (From)", async () => {
    // Both numbers happen to belong to orgs: `To` is the org being called, so
    // it must win over the caller's number.
    phoneRows = [
      { orgId: "org-called", number: "+15551110000", status: "active" },
      { orgId: "org-caller", number: "+15552220000", status: "active" },
    ];
    expect(await resolveOrgIdForNumbers("+15551110000", "+15552220000")).toBe("org-called");
    expect(await resolveOrgIdForNumbers("+15552220000", "+15551110000")).toBe("org-caller");
  });

  it("checks the legacy column before the provisioned table for the same number, matching twilio-signature.ts's precedence", async () => {
    orgRows = [{ orgId: "org-legacy", number: "+15551110000" }];
    phoneRows = [{ orgId: "org-provisioned", number: "+15551110000", status: "active" }];
    expect(await resolveOrgIdForNumbers("+15551110000")).toBe("org-legacy");
  });

  it("falls through to From when To belongs to nobody (first webhook of an outbound call)", async () => {
    phoneRows = [{ orgId: "org-dialer", number: "+15551110000", status: "active" }];
    expect(await resolveOrgIdForNumbers("+919999999999", "+15551110000")).toBe("org-dialer");
  });

  it("does not hit the database at all when no usable number was reported", async () => {
    expect(await resolveOrgIdForNumbers(undefined, null, "", "   ")).toBeNull();
    expect(queriedTables).toEqual([]);
  });

  it("swallows a lookup failure and returns null — attribution must never drop a live call", async () => {
    selectShouldThrow = true;
    phoneRows = [{ orgId: "org-shop", number: "+15551110000", status: "active" }];
    expect(await resolveOrgIdForNumbers("+15551110000")).toBeNull();
  });
});
