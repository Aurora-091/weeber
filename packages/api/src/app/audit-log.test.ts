import { mock, describe, it, expect, beforeEach } from "bun:test";

let inserted: Array<Record<string, unknown>> = [];
let selectRows: Array<Record<string, unknown>> = [];

mock.module("../database", () => ({
  db: {
    insert: (_table: unknown) => ({
      values: (data: Record<string, unknown>) => {
        inserted.push(data);
        return Promise.resolve();
      },
    }),
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: (n: number) => selectRows.slice(0, n),
        }),
      }),
    }),
  },
}));

import { logAdminAction, listAdminAuditLog } from "./audit-log";

describe("audit-log", () => {
  beforeEach(() => {
    inserted = [];
    selectRows = [];
  });

  it("records actor, action, and detail", async () => {
    await logAdminAction("env-admin-key", "flag.updated", { key: "beta-x", enabled: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual({
      actor: "env-admin-key",
      action: "flag.updated",
      detail: { key: "beta-x", enabled: true },
    });
  });

  it("defaults detail to null when omitted", async () => {
    await logAdminAction("env-admin-key", "broadcast.created");
    expect(inserted[0]!.detail).toBeNull();
  });

  it("clamps the list limit to a sane range", async () => {
    selectRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const rows = await listAdminAuditLog(2);
    expect(rows).toHaveLength(2);
  });
});
