import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Per-org intake-schema store — the Phase 2 editor's write-side compliance
 * chokepoint (validateSchemaDefs) and the single resolver every read path
 * shares (resolveIntakeSchema). The DB client is mocked so we drive the
 * resolver's fallback order and the null-agent read-then-write path
 * deterministically; intake-schema is left REAL so the regulated-field denylist
 * runs for real.
 */
process.env.DATABASE_URL ??= "file:./.test-schema-store.db";

// FIFO queue of rows each successive db.select().…limit() returns.
let selectQueue: unknown[][] = [];
// Every mutating call recorded so we can assert update-vs-insert-vs-delete.
const writeLog: Array<{ op: "update" | "insert" | "delete"; payload?: unknown }> = [];

function makeSelect() {
  const chain = {
    from() {
      return chain;
    },
    where() {
      return chain;
    },
    limit() {
      return Promise.resolve(selectQueue.shift() ?? []);
    },
  };
  return chain;
}

mock.module("../../database", () => ({
  db: {
    select: () => makeSelect(),
    update: () => ({
      set(v: unknown) {
        return {
          where() {
            writeLog.push({ op: "update", payload: v });
            return Promise.resolve();
          },
        };
      },
    }),
    insert: () => ({
      values(v: unknown) {
        writeLog.push({ op: "insert", payload: v });
        return Promise.resolve();
      },
    }),
    delete: () => ({
      where() {
        writeLog.push({ op: "delete" });
        return Promise.resolve();
      },
    }),
  },
}));

mock.module("../../database/with-retry", () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}));

const { validateSchemaDefs, resolveIntakeSchema, setOrgIntakeSchema } = await import("./schema-store");
const { defaultIntakeSchema } = await import("./intake-schema");

beforeEach(() => {
  selectQueue = [];
  writeLog.length = 0;
});

describe("validateSchemaDefs (write-side compliance chokepoint)", () => {
  it("rejects a regulated field by label and records it, dropping it from valid", () => {
    const { valid, rejectedRegulated } = validateSchemaDefs([
      { label: "Policy interest", type: "text" },
      { label: "SSN", type: "text" },
    ]);
    expect(valid.map((f) => f.label)).toEqual(["Policy interest"]);
    expect(rejectedRegulated.length).toBe(1);
    expect(valid.some((f) => /ssn/i.test(f.key) || /ssn/i.test(f.label))).toBe(false);
  });

  it("rejects a regulated field by key even when the label looks benign", () => {
    const { valid, rejectedRegulated } = validateSchemaDefs([
      { key: "aadhaar_number", label: "Reference", type: "text" },
    ]);
    expect(valid.length).toBe(0);
    expect(rejectedRegulated.length).toBe(1);
  });

  it("derives a snake_case key from the label and de-dupes repeated keys", () => {
    const { valid } = validateSchemaDefs([
      { label: "Coverage Type", type: "text" },
      { label: "coverage type", type: "text" },
    ]);
    expect(valid.length).toBe(1);
    expect(valid[0].key).toBe("coverage_type");
  });

  it("downgrades an enum with no options to text", () => {
    const { valid } = validateSchemaDefs([{ label: "Plan", type: "enum", options: [] }]);
    expect(valid[0].type).toBe("text");
  });

  it("keeps a valid enum's de-duped options", () => {
    const { valid } = validateSchemaDefs([{ label: "Plan", type: "enum", options: ["Auto", "Auto", "Home"] }]);
    expect(valid[0].type).toBe("enum");
    expect(valid[0].options).toEqual(["Auto", "Home"]);
  });

  it("returns empty for non-array input rather than throwing", () => {
    expect(validateSchemaDefs(null).valid).toEqual([]);
    expect(validateSchemaDefs("nope").valid).toEqual([]);
  });
});

describe("resolveIntakeSchema (fallback order)", () => {
  const agentFields = [{ key: "a", label: "A", type: "text" as const }];
  const orgFields = [{ key: "o", label: "O", type: "text" as const }];

  it("prefers a per-agent override when present", async () => {
    selectQueue = [[{ fields: agentFields }]];
    const out = await resolveIntakeSchema("org_1", "insurance", 7);
    expect(out).toEqual(agentFields);
  });

  it("falls back to the org-default row when the agent has none", async () => {
    // agent query → empty, org query → orgFields
    selectQueue = [[], [{ fields: orgFields }]];
    const out = await resolveIntakeSchema("org_1", "insurance", 7);
    expect(out).toEqual(orgFields);
  });

  it("falls back to the vertical default when no rows exist", async () => {
    selectQueue = [[]]; // org query only (no agentId) → empty
    const out = await resolveIntakeSchema("org_1", "insurance");
    expect(out).toEqual(defaultIntakeSchema("insurance"));
  });
});

describe("setOrgIntakeSchema (null-agent read-then-write, no duplicate)", () => {
  it("updates in place when an org-default row already exists", async () => {
    selectQueue = [[{ id: 5 }]]; // existing row found
    await setOrgIntakeSchema("org_1", [{ label: "Coverage", type: "text" }], null);
    expect(writeLog.map((w) => w.op)).toEqual(["update"]);
  });

  it("inserts when no org-default row exists yet", async () => {
    selectQueue = [[]]; // no existing row
    await setOrgIntakeSchema("org_1", [{ label: "Coverage", type: "text" }], null);
    expect(writeLog.map((w) => w.op)).toEqual(["insert"]);
  });

  it("resets (deletes) instead of storing an empty schema", async () => {
    const res = await setOrgIntakeSchema("org_1", [], null);
    expect(res.reset).toBe(true);
    expect(writeLog.map((w) => w.op)).toEqual(["delete"]);
  });

  it("strips regulated fields before persisting and reports them", async () => {
    selectQueue = [[]]; // will insert the surviving field
    const res = await setOrgIntakeSchema("org_1", [{ label: "PAN" }, { label: "Coverage", type: "text" }], null);
    expect(res.rejectedRegulated.length).toBe(1);
    expect(res.fields.map((f) => f.label)).toEqual(["Coverage"]);
    expect(writeLog.map((w) => w.op)).toEqual(["insert"]);
  });
});
