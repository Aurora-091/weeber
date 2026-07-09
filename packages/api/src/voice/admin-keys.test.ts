import { describe, it, expect } from "bun:test";

// admin-keys.ts imports the shared `db` client at module scope for the
// DB-touching CRUD functions this file doesn't exercise directly — a local
// sqlite file URL satisfies that import without real Turso credentials.
process.env.DATABASE_URL ??= "file:./.test-admin-keys.db";

const { hashAdminKey } = await import("./admin-keys");

describe("hashAdminKey", () => {
  it("is deterministic — the same key always hashes the same way", () => {
    expect(hashAdminKey("ovk_abc123")).toBe(hashAdminKey("ovk_abc123"));
  });

  it("produces different hashes for different keys", () => {
    expect(hashAdminKey("ovk_abc123")).not.toBe(hashAdminKey("ovk_xyz789"));
  });

  it("never returns the plaintext key itself", () => {
    const key = "ovk_super-secret-value";
    expect(hashAdminKey(key)).not.toContain(key);
  });

  it("produces a fixed-length hex digest regardless of input length", () => {
    expect(hashAdminKey("short")).toHaveLength(64);
    expect(hashAdminKey("a".repeat(500))).toHaveLength(64);
  });
});
