/**
 * Multi-user dashboard auth (ADR-025) — labeled API keys. See middleware/
 * admin-auth.ts for how these are checked on every request; this module
 * owns generation, hashing, and the CRUD operations behind the dashboard's
 * key-management page.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../database";
import { adminKeys } from "../database/schema";

const KEY_PREFIX = "ovk_";

/** SHA-256 is deliberately used, not a slow password hash (bcrypt/argon2) —
 * these are high-entropy generated tokens, not user-chosen passwords, so
 * there's no offline-guessing risk a slow hash defends against, and a fast
 * hash keeps the auth check cheap on every single admin-gated request. */
export function hashAdminKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function generatePlaintextKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

export type AdminKeySummary = {
  id: number;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

/** Creates a new key. Returns the plaintext key exactly once — it is never
 * retrievable again after this call returns, only the hash is stored. */
export async function createAdminKey(label: string): Promise<{ id: number; label: string; key: string }> {
  const key = generatePlaintextKey();
  const [row] = await db
    .insert(adminKeys)
    .values({ label, keyHash: hashAdminKey(key) })
    .returning({ id: adminKeys.id, label: adminKeys.label });
  return { id: row!.id, label: row!.label, key };
}

export async function listAdminKeys(): Promise<AdminKeySummary[]> {
  const rows = await db
    .select({
      id: adminKeys.id,
      label: adminKeys.label,
      createdAt: adminKeys.createdAt,
      lastUsedAt: adminKeys.lastUsedAt,
      revokedAt: adminKeys.revokedAt,
    })
    .from(adminKeys)
    .orderBy(adminKeys.createdAt);
  return rows;
}

/** Soft-delete — sets revokedAt rather than removing the row, so there's an
 * audit trail of keys that existed and when they stopped working. */
export async function revokeAdminKey(id: number): Promise<void> {
  await db.update(adminKeys).set({ revokedAt: new Date() }).where(eq(adminKeys.id, id));
}

/** Looks up a plaintext key against the table of non-revoked keys, and — if
 * found — updates lastUsedAt (best-effort, doesn't block the caller on it). */
export async function findActiveAdminKey(plaintextKey: string) {
  const hash = hashAdminKey(plaintextKey);
  const [row] = await db
    .select({ id: adminKeys.id })
    .from(adminKeys)
    .where(and(eq(adminKeys.keyHash, hash), isNull(adminKeys.revokedAt)))
    .limit(1);
  if (row) {
    void db.update(adminKeys).set({ lastUsedAt: new Date() }).where(eq(adminKeys.id, row.id)).catch(() => undefined);
  }
  return row ?? null;
}

/** Whether any labeled key has ever been created — used by the auth
 * middleware to decide whether "no ADMIN_API_KEY set" should still fall back
 * to the old warn-and-allow local-dev behavior, or actually enforce (once an
 * operator has deliberately started using labeled keys instead). */
export async function hasAnyAdminKey(): Promise<boolean> {
  const [row] = await db.select({ id: adminKeys.id }).from(adminKeys).limit(1);
  return Boolean(row);
}
