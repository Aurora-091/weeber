import { describe, it, expect } from "bun:test";

// caller-memory.ts imports the shared `db` client at module scope (for the
// non-pure getCallerMemory/upsertCallerMemory functions this file doesn't
// otherwise exercise) — a local sqlite file URL is enough to satisfy that
// import without needing real Turso credentials, matching how this module
// would run in any real deployment that hasn't configured a remote DB yet.
process.env.DATABASE_URL ??= "file:./.test-caller-memory.db";

const { resolveHumanNumber } = await import("./caller-memory");

describe("resolveHumanNumber", () => {
  it("uses fromNumber for an inbound call (the caller is the human)", () => {
    expect(resolveHumanNumber("inbound", "+15551234567", "+15559999999")).toBe("+15551234567");
  });

  it("uses toNumber for an outbound call (fromNumber is the operator's own Twilio number)", () => {
    expect(resolveHumanNumber("outbound", "+15559999999", "+15551234567")).toBe("+15551234567");
  });
});
