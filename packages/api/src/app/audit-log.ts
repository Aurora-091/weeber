/**
 * Generic admin-action audit log (see schema.ts's `adminAuditLog`). The
 * admin panel's Logs page reads this — "who changed what, when" — not raw
 * process logs, since no log-shipping infra exists and this is the more
 * useful surface anyway. Append-only. Best-effort: a logging failure should
 * never block the actual admin action it's describing.
 */
import { desc } from "drizzle-orm";
// ADR-116 addendum: admin action log, only ever called from admin-routes.ts,
// never on a live call's turn path — uses the background connection pool.
import { dbBackground as db } from "../database";
import { adminAuditLog } from "../database/schema";

export async function logAdminAction(actor: string, action: string, detail?: unknown): Promise<void> {
  try {
    await db
      .insert(adminAuditLog)
      .values({ actor, action, detail: detail ?? null })
      .catch((err: unknown) => console.error("[audit-log] failed to record admin action", action, err));
  } catch (err) {
    console.error("[audit-log] failed to record admin action", action, err);
  }
}

export async function listAdminAuditLog(limit = 200) {
  const bounded = Math.min(Math.max(limit, 1), 1000);
  return db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(bounded);
}
