import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Real impersonation-module behavior: one-time token with only its hash
 * stored, ~30-minute TTL, stop/expiry closing out the append-only audit row.
 * (This file must import the REAL ./impersonation — routes.test.ts in this
 * directory mocks that module, and bun mock.module registrations leak
 * forward across files; alphabetical order keeps this file first.)
 */

let rowsByTable: Record<string, unknown[]> = {};
let insertsByTable: Record<string, Record<string, unknown>[]> = {};
let updatesByTable: Record<string, Record<string, unknown>[]> = {};

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
      values: (data: Record<string, unknown>) => {
        (insertsByTable[getTableName(table) ?? ""] ??= []).push(data);
        return { returning: () => Promise.resolve([{ id: 11, ...data }]) };
      },
    }),
    update: (table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: () => {
          (updatesByTable[getTableName(table) ?? ""] ??= []).push(data);
          // Thenable AND returning-capable: stopImpersonation awaits
          // .returning(), the expiry path fire-and-forgets with .catch().
          const promise = Promise.resolve([{ id: 11 }]) as Promise<unknown[]> & Record<string, unknown>;
          promise.returning = () => Promise.resolve([{ id: 11 }]);
          return promise;
        },
      }),
    }),
  },
}));

import { startImpersonation, stopImpersonation, findActiveImpersonation } from "./impersonation";

describe("impersonation sessions", () => {
  beforeEach(() => {
    rowsByTable = { orgs: [], impersonation_sessions: [] };
    insertsByTable = {};
    updatesByTable = {};
  });

  it("returns null for an unknown org", async () => {
    expect(await startImpersonation("org-nope", "env-admin-key")).toBeNull();
  });

  it("mints an ovi_ token with a ~30 minute TTL, storing only the hash", async () => {
    rowsByTable.orgs = [{ id: "org-1" }];
    const session = await startImpersonation("org-1", "jane-laptop");
    expect(session).not.toBeNull();
    expect(session!.token.startsWith("ovi_")).toBe(true);
    const ttlMs = session!.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(25 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(30 * 60_000);

    const audit = insertsByTable.impersonation_sessions?.[0] as {
      orgId: string;
      adminActor: string;
      tokenHash: string;
    };
    expect(audit.orgId).toBe("org-1");
    expect(audit.adminActor).toBe("jane-laptop");
    expect(audit.tokenHash).toHaveLength(64); // sha256 hex
    expect(audit.tokenHash).not.toBe(session!.token);
  });

  it("stop sets endedAt/endedReason (append-only, no delete)", async () => {
    const stopped = await stopImpersonation(11);
    expect(stopped).toBe(true);
    const update = updatesByTable.impersonation_sessions?.[0] as { endedReason: string; endedAt: Date };
    expect(update.endedReason).toBe("stopped");
    expect(update.endedAt).toBeInstanceOf(Date);
  });

  it("resolves a live token and rejects an expired one (closing it out)", async () => {
    rowsByTable.impersonation_sessions = [
      { id: 5, orgId: "org-1", adminActor: "env-admin-key", expiresAt: new Date(Date.now() + 60_000) },
    ];
    expect(await findActiveImpersonation("whatever")).toEqual({
      id: 5,
      orgId: "org-1",
      adminActor: "env-admin-key",
    });

    rowsByTable.impersonation_sessions = [
      { id: 6, orgId: "org-1", adminActor: "env-admin-key", expiresAt: new Date(Date.now() - 1_000) },
    ];
    expect(await findActiveImpersonation("whatever")).toBeNull();
  });
});
