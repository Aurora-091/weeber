/**
 * Call → org attribution from the carrier-reported phone numbers.
 *
 * Why this exists: for an OUTBOUND call we place ourselves, the org is already
 * known — placeOutboundCall stamps it into the session, and every insert path
 * reads `session.orgId`. A genuinely INBOUND call has no session to read: the
 * first thing we ever learn about it is Twilio's webhook, whose only org-
 * identifying signal is the number that was dialled. Before this helper both
 * insert paths (voice/routes.ts's `/incoming` and stream.ts's WS-start
 * fallback) fell back to `session?.orgId ?? null`, so every inbound call was
 * persisted with `orgId: null`. That is not merely a reporting gap — a null
 * orgId silently degrades four downstream consumers in stream.ts:
 *   - getCallerMemory()   → no cross-call memory for a returning caller
 *   - getEffectiveFlags() → `{}`, so no org feature flags apply
 *   - resolveAgentConfig()→ falls back to a generic persona, not the org's
 *   - resolveCrmSyncContext() → no CRM sync for the call
 *
 * The lookup itself is not new logic: middleware/twilio-signature.ts already
 * does the same number → org resolution one layer up (to pick the right
 * sub-account auth token) and then discards the result. This is that chain,
 * shared, so the two insert paths can never disagree about who a call
 * belongs to.
 *
 * Deliberately best-effort: a lookup failure returns null and never throws,
 * because attribution must never be able to drop a live call.
 */
import { inArray } from "drizzle-orm";
import { db } from "../database";
import { orgPhoneNumbers, orgs } from "../database/schema";

/**
 * Resolves the org that owns one of `numbers`, in the order given.
 *
 * Callers pass `To` before `From`: on a fresh inbound call the org's own
 * number is `To` (`From` is the caller's), while on the very first webhook of
 * an outbound call it is `From` — same two-candidate reasoning as
 * middleware/twilio-signature.ts's resolveAuthTokenForRequest.
 *
 * Per candidate, the legacy `orgs.outboundNumber` column is checked before
 * the `org_phone_numbers` table, matching that middleware's precedence so an
 * org that predates C2b provisioning resolves identically in both places.
 * Released numbers are excluded: the org no longer owns them, so attributing
 * a call to it would be wrong. (The signature middleware does not make that
 * distinction — it only needs *an* auth token — which is why the filter lives
 * here rather than being pushed into a shared query.)
 *
 * Returns null when nothing matches, which is the correct outcome for
 * self-hosted OpenVent usage with no orgs at all.
 */
export async function resolveOrgIdForNumbers(
  ...numbers: (string | null | undefined)[]
): Promise<string | null> {
  const candidates: string[] = [];
  for (const raw of numbers) {
    const number = raw?.trim();
    if (number && !candidates.includes(number)) candidates.push(number);
  }
  if (candidates.length === 0) return null;

  try {
    const [legacyRows, provisionedRows] = await Promise.all([
      db
        .select({ orgId: orgs.id, number: orgs.outboundNumber })
        .from(orgs)
        .where(inArray(orgs.outboundNumber, candidates)),
      db
        .select({
          orgId: orgPhoneNumbers.orgId,
          number: orgPhoneNumbers.phoneNumber,
          status: orgPhoneNumbers.status,
        })
        .from(orgPhoneNumbers)
        .where(inArray(orgPhoneNumbers.phoneNumber, candidates)),
    ]);

    for (const candidate of candidates) {
      const legacy = legacyRows.find((row) => row.number === candidate);
      if (legacy?.orgId) return legacy.orgId;
      // Status is filtered here rather than in the WHERE clause: an exact-
      // match lookup on at most two numbers returns a handful of rows either
      // way, and keeping the predicate in TS keeps it unit-testable.
      const provisioned = provisionedRows.find(
        (row) => row.number === candidate && row.status === "active",
      );
      if (provisioned?.orgId) return provisioned.orgId;
    }

    return null;
  } catch (err) {
    console.error("[voice] org attribution lookup failed", err);
    return null;
  }
}
