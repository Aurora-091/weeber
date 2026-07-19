/**
 * Per-org lead ingest API keys (2026-07-19,
 * docs/product-strategy/native-leads-layer-plan-2026-07-19.md §7).
 *
 * Same generation/hashing shape as admin-keys.ts (SHA-256 of a high-entropy
 * generated token — no slow password hash needed, and it keeps the auth check
 * cheap on every ingest request), but org-SCOPED and ingest-ONLY: a leaked key
 * affects exactly one org, is revocable, and can never read another org's data
 * or reach the dashboard. Safe to hand to a client's form/CRM/Pipedream.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../database";
import { leadApiKeys } from "../../database/schema";

const KEY_PREFIX = "wlk_"; // weeber lead key

export function hashLeadApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function generatePlaintextKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

export type LeadApiKeySummary = {
  id: number;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

/** Creates a new ingest key for an org. Returns the plaintext key exactly once
 * — only the hash is stored, it's never retrievable again. */
export async function createLeadApiKey(orgId: string, label: string): Promise<{ id: number; label: string; key: string }> {
  const key = generatePlaintextKey();
  const [row] = await db
    .insert(leadApiKeys)
    .values({ orgId, label, keyHash: hashLeadApiKey(key) })
    .returning({ id: leadApiKeys.id, label: leadApiKeys.label });
  return { id: row!.id, label: row!.label, key };
}

export async function listLeadApiKeys(orgId: string): Promise<LeadApiKeySummary[]> {
  return db
    .select({
      id: leadApiKeys.id,
      label: leadApiKeys.label,
      createdAt: leadApiKeys.createdAt,
      lastUsedAt: leadApiKeys.lastUsedAt,
      revokedAt: leadApiKeys.revokedAt,
    })
    .from(leadApiKeys)
    .where(eq(leadApiKeys.orgId, orgId))
    .orderBy(leadApiKeys.createdAt);
}

/** Soft-delete — sets revokedAt (audit trail of keys that existed). Org-scoped
 * so one org can't revoke another's key even with a guessed id. */
export async function revokeLeadApiKey(orgId: string, id: number): Promise<void> {
  await db
    .update(leadApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(leadApiKeys.id, id), eq(leadApiKeys.orgId, orgId)));
}

/**
 * Resolves a plaintext key to the org it authorizes, or null if it's unknown/
 * revoked. Updates lastUsedAt best-effort (doesn't block the caller). This is
 * the auth chokepoint for POST /api/leads/ingest — the returned orgId is the
 * ONLY org that request may write to.
 */
export async function resolveLeadApiKey(plaintextKey: string): Promise<{ id: number; orgId: string } | null> {
  if (!plaintextKey) return null;
  const hash = hashLeadApiKey(plaintextKey);
  const [row] = await db
    .select({ id: leadApiKeys.id, orgId: leadApiKeys.orgId })
    .from(leadApiKeys)
    .where(and(eq(leadApiKeys.keyHash, hash), isNull(leadApiKeys.revokedAt)))
    .limit(1);
  if (row) {
    void db
      .update(leadApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(leadApiKeys.id, row.id))
      .catch(() => undefined);
  }
  return row ?? null;
}
