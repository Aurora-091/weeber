/**
 * ADR-112 — record a bring-your-own number in `org_phone_numbers`.
 *
 * `buyNumberForOrg` has always inserted an `org_phone_numbers` row for a number
 * rented under a platform sub-account. None of the three BYO paths did:
 * `setByoCredentials`, `setPlivoByoCredentials` and `setExotelByoCredentials`
 * each wrote `orgs.outboundNumber` and nothing else. So an org that brought its
 * own Twilio/Plivo/Exotel number had a working outbound number and no row
 * representing it, which broke three things that all read the table rather than
 * the legacy column:
 *
 *   1. The Numbers page renders from `org_phone_numbers`, so it was empty — and
 *      `numberSeries` is set there. A BYO org therefore had no way to declare a
 *      TRAI/DLT series, which makes `checkIndiaNumberSeriesCompliance`
 *      unsatisfiable for a BYO Shopify org and the insurance 1600-series gate
 *      unsatisfiable by construction. A compliance gate an honest org cannot
 *      pass is not enforcement, it is a wall.
 *   2. `orgAgentConfigs.phoneNumberId` is an FK into this table, so per-agent
 *      number assignment could not be expressed at all. `resolveOutboundRouting`
 *      steps 1 and 2 both missed and every BYO call fell through to step 3, the
 *      legacy `orgs.outboundNumber`. Per-agent routing was silently dead for
 *      exactly the orgs most likely to want it.
 *   3. `syncNumberWebhooksForOrg` iterates this table, so a BYO number's
 *      webhooks were outside the repair path — the same shape of invisibility
 *      that left the legacy platform number with a dead webhook nothing could
 *      fix (see `buyNumberForOrg`'s note).
 *
 * This is deliberately a shared helper rather than three copies: the reason
 * those three functions drifted from `buyNumberForOrg` in the first place is
 * that each one owns its own persistence block, and a fourth provider would
 * have drifted the same way.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import { orgPhoneNumbers } from "../database/schema";

export type TelephonyProviderName = "twilio" | "plivo" | "exotel";

/** The subset of an `org_phone_numbers` row the supersede rule needs. */
export type SupersedeCandidate = {
  id: number;
  source: "purchased" | "byo" | null;
};

/**
 * Which of an org's currently-active numbers a newly-registered BYO number
 * supersedes. Pure and exported so the safety rule is asserted directly rather
 * than inferred from a mocked SQL predicate — this function deciding wrongly is
 * the difference between tidying a stale row and silently taking an org's paid,
 * dialable number out of rotation.
 *
 * Only `source === "byo"` rows other than the new one are superseded.
 * `"purchased"` is billed monthly and still dialable. `null` predates the
 * `source` column (ADR-112) so its provenance is unknown, and unknown is
 * treated as untouchable: the cost of leaving a stale row active is one
 * confusing entry on the Numbers page, while the cost of releasing a live
 * purchased number is a broken caller ID nobody asked us to change.
 */
export function supersededByoNumberIds(
  activeRows: readonly SupersedeCandidate[],
  keepId: number,
): number[] {
  return activeRows.filter((row) => row.id !== keepId && row.source === "byo").map((row) => row.id);
}

/**
 * Upserts the org's BYO number as an active `org_phone_numbers` row and
 * supersedes any previous BYO number for that org.
 *
 * Idempotent: re-running BYO setup with the same number re-activates the
 * existing row and updates its provider rather than accumulating duplicates.
 * `org_phone_numbers` has no unique constraint on `(org_id, phone_number)` —
 * adding one would require reconciling whatever duplicates already exist in
 * production, which is not a migration this change is willing to hide inside
 * itself — so the guard is an explicit read, not `onConflictDoNothing`.
 *
 * Supersession is scoped to `source = 'byo'` rows only. A `purchased` row is a
 * number the org is billed for monthly and can still dial from, and NULL means
 * the row predates this column so its provenance is unknown; both are left
 * alone. `releaseNumberForOrg` remains the only path that gives a rented number
 * back, and it stays an explicit user action — see `resetToPlatformDefault`'s
 * note on why a convenience path must never destroy a paid, dialable number.
 *
 * Note this only writes rows. It does not verify the number exists in the
 * provider's account or that the org may use it; the caller has already
 * validated the credentials against the provider's own API by the time this
 * runs, and the number itself is the customer's property in the BYO case.
 *
 * @returns the id of the active row for this number.
 */
export async function registerByoNumber(
  orgId: string,
  provider: TelephonyProviderName,
  phoneNumber: string,
): Promise<{ id: number }> {
  const number = phoneNumber.trim();

  const [existing] = await db
    .select({ id: orgPhoneNumbers.id })
    .from(orgPhoneNumbers)
    .where(and(eq(orgPhoneNumbers.orgId, orgId), eq(orgPhoneNumbers.phoneNumber, number)))
    .limit(1);

  let id: number;
  if (existing) {
    // Re-activate rather than insert a second row: a released BYO number the
    // org re-connects is the same number, and leaving the old row released
    // while adding a new one would make the Numbers page show it twice.
    await db
      .update(orgPhoneNumbers)
      .set({ provider, status: "active", source: "byo" })
      .where(eq(orgPhoneNumbers.id, existing.id));
    id = existing.id;
  } else {
    const [inserted] = await db
      .insert(orgPhoneNumbers)
      .values({ orgId, provider, phoneNumber: number, status: "active", source: "byo" })
      .returning({ id: orgPhoneNumbers.id });
    id = inserted!.id;
  }

  // Supersede the org's other BYO numbers. BYO is single-number by
  // construction — `orgs.outboundNumber` is one column and every BYO setup form
  // takes exactly one number — so a second active BYO row can only be a stale
  // one from a previous setup, and leaving it active would feed
  // `resolveOutboundRouting`'s org-level branch a number the org has already
  // moved off.
  //
  // The rows are read back and filtered in `supersededByoNumberIds` rather than
  // expressed as a `where` predicate. That costs one extra `select`, and buys a
  // safety rule that can be asserted directly in a test instead of being
  // trusted to a predicate no mock in this codebase evaluates.
  const activeRows = await db
    .select({ id: orgPhoneNumbers.id, source: orgPhoneNumbers.source })
    .from(orgPhoneNumbers)
    .where(and(eq(orgPhoneNumbers.orgId, orgId), eq(orgPhoneNumbers.status, "active")));

  const supersededIds = supersededByoNumberIds(activeRows, id);
  if (supersededIds.length > 0) {
    await db
      .update(orgPhoneNumbers)
      .set({ status: "released" })
      .where(inArray(orgPhoneNumbers.id, supersededIds));
  }

  return { id };
}
