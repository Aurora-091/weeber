import { describe, it, expect } from "bun:test";

// api-keys.ts imports the shared `db` client at module scope for its CRUD
// functions (not exercised here) — a local sqlite file URL satisfies that
// import without real Turso credentials, matching admin-keys.test.ts.
process.env.DATABASE_URL ??= "file:./.test-lead-api-keys.db";

const { hashLeadApiKey } = await import("./api-keys");

describe("hashLeadApiKey", () => {
  it("is deterministic — the same key always hashes the same way", () => {
    expect(hashLeadApiKey("wlk_abc123")).toBe(hashLeadApiKey("wlk_abc123"));
  });

  it("produces different hashes for different keys", () => {
    expect(hashLeadApiKey("wlk_abc123")).not.toBe(hashLeadApiKey("wlk_xyz789"));
  });

  it("never returns the plaintext key itself", () => {
    const key = "wlk_super-secret-value";
    expect(hashLeadApiKey(key)).not.toContain(key);
  });

  it("produces a fixed-length hex digest regardless of input length", () => {
    expect(hashLeadApiKey("short")).toHaveLength(64);
    expect(hashLeadApiKey("a".repeat(500))).toHaveLength(64);
  });
});
