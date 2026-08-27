/**
 * Global-only kill switch for the public demo-call widget. Deliberately not
 * `org-queries.ts`'s `getEffectiveFlags(orgId)` — that overlays an org-scoped row on top of a
 * global one, and this call site has no org/session context at all (the visitor isn't
 * authenticated into any org). A direct read of the `orgId: ""` row is all this needs.
 *
 * Fails CLOSED: `feature_flags` has 0 production rows as of the 2026-08-25 audit
 * (docs/brain/active-context.md), so "no row yet" must mean disabled, not enabled — the opposite
 * of `getEffectiveFlags`' own default, which doesn't matter for hot-path flags but would be
 * actively dangerous here (a fresh deploy silently able to place real, uncontrolled phone calls).
 */
import { eq, and } from "drizzle-orm";
import { db } from "../database";
import { featureFlags } from "../database/schema";

export async function isGlobalFlagEnabled(key: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(and(eq(featureFlags.key, key), eq(featureFlags.orgId, "")))
    .limit(1);
  return row?.enabled ?? false;
}
