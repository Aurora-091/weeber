import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * ADR-112 — a BYO number must land in `org_phone_numbers`, and registering one
 * must never take a paid number out of rotation.
 *
 * The supersede rule is tested directly against the pure
 * `supersededByoNumberIds` rather than through a mocked `where` predicate,
 * because no `db` mock in this package evaluates predicates — the existing one
 * in `twilio-subaccount-idempotency.test.ts` ignores `where` entirely. A test
 * that "passed" against such a mock would prove nothing about which rows a
 * `where` clause actually spares, which is the only property here whose failure
 * costs a customer a working caller ID.
 */

type Row = {
  id: number;
  orgId: string;
  phoneNumber: string;
  provider: string | null;
  status: string;
  source: "purchased" | "byo" | null;
};

let rows: Row[] = [];
/**
 * The mock cannot read a drizzle predicate, so the existence probe's `where` is
 * delegated to the test: this decides which existing row (if any) the probe
 * matches. Default is "no match", i.e. a fresh number.
 */
let probeMatch: (row: Row) => boolean = () => false;
let nextId = 1;
let updates: { set: Record<string, unknown> }[] = [];
let inserts: Record<string, unknown>[] = [];
mock.module("../database", () => ({
  db: {
    // `registerByoNumber` issues exactly two selects and they ask for different
    // column sets: the existence probe takes `{ id }`, the supersede read takes
    // `{ id, source }`. The mock dispatches on that rather than on the
    // predicate, and asserts the shape it was handed so a future refactor that
    // changes the queries fails loudly here instead of silently returning the
    // wrong rows.
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const keys = Object.keys(cols).sort().join(",");
          if (keys === "id") {
            const match = rows.filter(probeMatch).map((r) => ({ id: r.id }));
            return Object.assign(match, { limit: () => match });
          }
          if (keys === "id,source") {
            const active = rows.filter((r) => r.status === "active").map((r) => ({ id: r.id, source: r.source }));
            return Object.assign(active, { limit: () => active });
          }
          throw new Error(`unexpected select columns: ${keys}`);
        },
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ set });
          return undefined;
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserts.push(values);
          const row: Row = {
            id: nextId++,
            orgId: values.orgId as string,
            phoneNumber: values.phoneNumber as string,
            provider: (values.provider as string) ?? null,
            status: values.status as string,
            source: (values.source as Row["source"]) ?? null,
          };
          rows.push(row);
          return [{ id: row.id }];
        },
      }),
    }),
  },
}));

const { registerByoNumber, supersededByoNumberIds } = await import("./register-byo-number");

beforeEach(() => {
  rows = [];
  nextId = 1;
  updates = [];
  inserts = [];
  probeMatch = () => false;
});

describe("supersededByoNumberIds", () => {
  it("releases the org's other BYO numbers", () => {
    expect(
      supersededByoNumberIds(
        [
          { id: 1, source: "byo" },
          { id: 2, source: "byo" },
        ],
        2,
      ),
    ).toEqual([1]);
  });

  it("never touches a purchased number — it is billed monthly and still dialable", () => {
    expect(
      supersededByoNumberIds(
        [
          { id: 1, source: "purchased" },
          { id: 2, source: "byo" },
        ],
        2,
      ),
    ).toEqual([]);
  });

  it("never touches a row predating the source column, whose provenance is unknown", () => {
    expect(
      supersededByoNumberIds(
        [
          { id: 1, source: null },
          { id: 2, source: "byo" },
        ],
        2,
      ),
    ).toEqual([]);
  });

  it("never releases the number just registered", () => {
    expect(supersededByoNumberIds([{ id: 7, source: "byo" }], 7)).toEqual([]);
  });

  it("releases every other BYO row, not just the first", () => {
    expect(
      supersededByoNumberIds(
        [
          { id: 1, source: "byo" },
          { id: 2, source: "purchased" },
          { id: 3, source: "byo" },
          { id: 4, source: null },
          { id: 5, source: "byo" },
        ],
        5,
      ),
    ).toEqual([1, 3]);
  });

  // Non-vacuity: the mixed fixture above must actually contain rows the rule is
  // required to spare, otherwise the "spares" assertions could pass on an empty
  // filter.
  it("is exercised against a fixture that contains sparable rows", () => {
    const fixture: Parameters<typeof supersededByoNumberIds>[0] = [
      { id: 1, source: "byo" },
      { id: 2, source: "purchased" },
      { id: 4, source: null },
    ];
    expect(fixture.some((r) => r.source !== "byo")).toBe(true);
    expect(supersededByoNumberIds(fixture, 999).length).toBe(1);
  });
});

describe("registerByoNumber", () => {
  it("inserts an active BYO row so the Numbers page and per-agent routing can see it", async () => {
    const { id } = await registerByoNumber("org_1", "twilio", "+14155550100");

    expect(inserts).toEqual([
      {
        orgId: "org_1",
        provider: "twilio",
        phoneNumber: "+14155550100",
        status: "active",
        source: "byo",
      },
    ]);
    expect(id).toBe(1);
  });

  it("trims the number so a pasted value does not create a second row", async () => {
    await registerByoNumber("org_1", "plivo", "  +14155550100 \n");
    expect(inserts[0]!.phoneNumber).toBe("+14155550100");
  });

  it("is idempotent: re-running BYO setup re-activates the existing row instead of duplicating it", async () => {
    rows.push({
      id: 42,
      orgId: "org_1",
      phoneNumber: "+14155550100",
      provider: "twilio",
      status: "released",
      source: "byo",
    });
    probeMatch = (r) => r.phoneNumber === "+14155550100";

    const { id } = await registerByoNumber("org_1", "exotel", "+14155550100");

    expect(id).toBe(42);
    expect(inserts).toEqual([]);
    expect(updates[0]!.set).toEqual({ provider: "exotel", status: "active", source: "byo" });
  });

  it("supersedes a stale BYO row from a previous setup", async () => {
    rows.push({
      id: 5,
      orgId: "org_1",
      phoneNumber: "+14155550199",
      provider: "twilio",
      status: "active",
      source: "byo",
    });

    const { id } = await registerByoNumber("org_1", "twilio", "+14155550100");

    expect(id).not.toBe(5);
    const released = updates.filter((u) => u.set.status === "released");
    expect(released.length).toBe(1);
  });

  it("leaves a purchased number active when a BYO number is registered alongside it", async () => {
    rows.push({
      id: 5,
      orgId: "org_1",
      phoneNumber: "+14155550199",
      provider: "twilio",
      status: "active",
      source: "purchased",
    });

    await registerByoNumber("org_1", "twilio", "+14155550100");

    expect(updates.filter((u) => u.set.status === "released")).toEqual([]);
  });

  it("issues no supersede update when the org has nothing else active", async () => {
    await registerByoNumber("org_1", "twilio", "+14155550100");
    expect(updates.filter((u) => u.set.status === "released")).toEqual([]);
  });
});
