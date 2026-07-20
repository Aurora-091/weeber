/**
 * Fire-and-forget activity heartbeat (2026-07-20). Bumps orgs.lastActivityAt
 * so the inactivity lifecycle sweep (voice/workflows/org-lifecycle-sweep.ts)
 * treats an org that's placing/receiving calls as alive, even if nobody logs
 * into the dashboard (the /me path bumps it too). Never awaited on the call
 * hot path — a failed heartbeat must never affect a live call.
 */
import { eq } from "drizzle-orm";
import { db } from "../database";
import { orgs } from "../database/schema";

export function bumpOrgActivity(orgId: string | null | undefined): void {
  if (!orgId) return;
  // Wrapped in try/catch as well as .catch: a failed heartbeat (including a
  // synchronous throw, e.g. a mocked db without .update) must NEVER bubble
  // into the live-call hot path.
  try {
    const result = db
      .update(orgs)
      .set({ lastActivityAt: new Date() })
      .where(eq(orgs.id, orgId)) as unknown as Promise<unknown>;
    void Promise.resolve(result).catch((err) =>
      console.error(`[org-activity] heartbeat failed for ${orgId}`, err),
    );
  } catch (err) {
    console.error(`[org-activity] heartbeat threw for ${orgId}`, err);
  }
}
