/**
 * Merchant-impersonation sessions (CLAUDE-BUILD-BRIEF §4.6). The hard
 * requirement is the audit trail: every session records who (admin actor),
 * which org, start, and end — rows are append-only (see the schema comment
 * on `impersonationSessions`). The same table doubles as the session store:
 * the middleware resolves a presented token against it on every request, so
 * expiry/stop take effect immediately with no separate cache to invalidate.
 *
 * Token discipline mirrors admin-keys.ts: high-entropy generated token,
 * SHA-256 hash stored, plaintext returned exactly once at start.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../database";
import { impersonationSessions, orgs } from "../database/schema";

const TOKEN_PREFIX = "ovi_";
const DEFAULT_TTL_MINUTES = 30;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function startImpersonation(
  orgId: string,
  adminActor: string,
  ttlMinutes = DEFAULT_TTL_MINUTES,
): Promise<{ id: number; token: string; expiresAt: Date } | null> {
  const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!org) return null;

  const token = TOKEN_PREFIX + randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  const [row] = await db
    .insert(impersonationSessions)
    .values({ orgId, adminActor, tokenHash: hashToken(token), expiresAt })
    .returning({ id: impersonationSessions.id });
  return { id: row!.id, token, expiresAt };
}

/** Marks a session ended. Idempotent — stopping an already-ended session is a no-op. */
export async function stopImpersonation(id: number): Promise<boolean> {
  const [row] = await db
    .update(impersonationSessions)
    .set({ endedAt: new Date(), endedReason: "stopped" })
    .where(and(eq(impersonationSessions.id, id), isNull(impersonationSessions.endedAt)))
    .returning({ id: impersonationSessions.id });
  return Boolean(row);
}

/**
 * Resolves a presented token to its live session, or null. A token past its
 * expiry gets its row closed out (`endedReason: "expired"`) on first sight —
 * best-effort bookkeeping so the audit log shows an end time even when
 * nobody clicked Stop.
 */
export async function findActiveImpersonation(
  token: string,
): Promise<{ id: number; orgId: string; adminActor: string } | null> {
  const hash = hashToken(token);
  const [row] = await db
    .select({
      id: impersonationSessions.id,
      orgId: impersonationSessions.orgId,
      adminActor: impersonationSessions.adminActor,
      expiresAt: impersonationSessions.expiresAt,
    })
    .from(impersonationSessions)
    .where(and(eq(impersonationSessions.tokenHash, hash), isNull(impersonationSessions.endedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    void db
      .update(impersonationSessions)
      .set({ endedAt: new Date(), endedReason: "expired" })
      .where(and(eq(impersonationSessions.id, row.id), isNull(impersonationSessions.endedAt)))
      .catch(() => undefined);
    return null;
  }
  return { id: row.id, orgId: row.orgId, adminActor: row.adminActor };
}

export async function listImpersonationAudit(opts: { orgId?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const base = db
    .select({
      id: impersonationSessions.id,
      orgId: impersonationSessions.orgId,
      adminActor: impersonationSessions.adminActor,
      startedAt: impersonationSessions.startedAt,
      expiresAt: impersonationSessions.expiresAt,
      endedAt: impersonationSessions.endedAt,
      endedReason: impersonationSessions.endedReason,
    })
    .from(impersonationSessions)
    .orderBy(desc(impersonationSessions.startedAt))
    .limit(limit);
  return opts.orgId ? base.where(eq(impersonationSessions.orgId, opts.orgId)) : base;
}

/** Live sessions for an org — lets the admin UI show/stop what's currently open. */
export async function listActiveImpersonations(orgId?: string) {
  const conditions = [isNull(impersonationSessions.endedAt), gt(impersonationSessions.expiresAt, new Date())];
  if (orgId) conditions.push(eq(impersonationSessions.orgId, orgId));
  return db
    .select({
      id: impersonationSessions.id,
      orgId: impersonationSessions.orgId,
      adminActor: impersonationSessions.adminActor,
      startedAt: impersonationSessions.startedAt,
      expiresAt: impersonationSessions.expiresAt,
    })
    .from(impersonationSessions)
    .where(and(...conditions))
    .orderBy(desc(impersonationSessions.startedAt));
}
