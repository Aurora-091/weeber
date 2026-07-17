/**
 * General India DLT number-series compliance gate (2026-07-17, follow-up to
 * checkInsuranceNumberSeriesCompliance in insurance-gates.ts). That check is
 * insurance-only (hardcoded to require a `1600`-series number, an IRDAI-
 * specific mandate) and unconditional — it stays exactly as-is, untouched by
 * this file, so the existing live insurance enforcement is never weakened.
 *
 * This is the generic version for every *other* vertical: TRAI requires any
 * business placing commercial/telemarketing calls in India to dial from a
 * DLT-registered number (140-series for promotional/telemarketing, 160-
 * series for transactional/service — see docs/merchant-dlt-onboarding.md),
 * not just insurance's narrower 1600-series mandate. A Shopify org calling
 * India numbers today has *no* platform-side check that its outbound number
 * is registered at all.
 *
 * Insurance orgs are explicitly skipped here (delegated entirely to the
 * existing dedicated check) — this file only ever changes behavior for
 * non-insurance verticals, same "no-op unless this org's vertical is the one
 * this check is actually for" discipline as every other vertical-scoped gate
 * in this codebase.
 *
 * Kill-switch, off by default (INDIA_NUMBER_SERIES_FLAG, resolved the same
 * org/global way as ADAPTIVE_NOISE_FILTER_FLAG et al.): flipping this on
 * immediately blocks any org whose outbound number has no registered DLT
 * series at all — a real, live production Shopify org today (Twilio number,
 * `numberSeries` unset) *does* dial India numbers, so enabling this
 * unconditionally by default would have broken working, already-paying
 * traffic the moment this shipped. Opt-in per org (or globally, once every
 * real org has a registered number) via the existing /flags admin route.
 */
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../../database";
import { orgs, orgPhoneNumbers } from "../../database/schema";
import { getEffectiveFlags } from "../org-queries";

export type NumberSeriesGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Real TRAI/DLT number series values this platform tracks (schema.ts's
 * `orgPhoneNumbers.numberSeries` enum) — kept here as a local alias so this
 * file doesn't need a schema import just for the type. */
type NumberSeries = "140" | "160" | "1600";

function isIndianNumber(e164: string): boolean {
  return /^\+91\d{10}$/.test(e164);
}

export const INDIA_NUMBER_SERIES_FLAG = "india-number-series-compliance";

/**
 * Which registered series satisfy this gate, per vertical. Insurance isn't
 * listed — it's excluded entirely below, delegated to
 * checkInsuranceNumberSeriesCompliance's own stricter, unconditional 1600-
 * only requirement. `default` covers Shopify and any vertical without a
 * more specific entry: TRAI's own split is 140 (promotional/telemarketing)
 * vs 160 (transactional/service) — a Shopify org's calls span both
 * (cart-recovery reads as promotional outreach, COD-confirmation reads as
 * transactional), and this check only has the destination number at dial
 * time, not which specific agent/template is calling, so it accepts either
 * registered series rather than guessing which one a given call "should"
 * be. Not the same as accepting an *unregistered* number — this still
 * requires at least one of the two.
 */
const REQUIRED_SERIES_BY_VERTICAL: Record<string, readonly NumberSeries[]> = {
  default: ["140", "160"],
};

/**
 * General India DLT number-series gate — the non-insurance counterpart to
 * checkInsuranceNumberSeriesCompliance. Returns allowed:true (no-op)
 * whenever: there's no orgId, the destination isn't an Indian number, this
 * org is insurance-vertical (handled elsewhere), or the
 * INDIA_NUMBER_SERIES_FLAG isn't on for this org. Otherwise blocks unless
 * the org has at least one active phone number registered under a series
 * acceptable for its vertical.
 *
 * `flags` is an optional pre-fetched getEffectiveFlags() result — callers
 * that already fetched flags for this org this request (e.g. stream.ts's
 * "start" handler) can pass it straight through instead of this function
 * doing its own redundant round-trip; omitted, it fetches its own.
 */
export async function checkIndiaNumberSeriesCompliance(
  orgId: string | null | undefined,
  toNumber: string,
  flags?: Record<string, boolean>,
): Promise<NumberSeriesGateResult> {
  if (!orgId) return { allowed: true };
  if (!isIndianNumber(toNumber)) return { allowed: true };

  const [org] = await db.select({ vertical: orgs.vertical }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  // Insurance has its own, stricter, unconditional gate — never double up here.
  if (org?.vertical === "insurance") return { allowed: true };

  const effectiveFlags = flags ?? (await getEffectiveFlags(orgId).catch(() => ({}) as Record<string, boolean>));
  if (effectiveFlags[INDIA_NUMBER_SERIES_FLAG] !== true) return { allowed: true };

  const acceptableSeries = REQUIRED_SERIES_BY_VERTICAL[org?.vertical ?? "default"] ?? REQUIRED_SERIES_BY_VERTICAL.default!;

  const [compliantNumber] = await db
    .select({ id: orgPhoneNumbers.id })
    .from(orgPhoneNumbers)
    .where(
      and(
        eq(orgPhoneNumbers.orgId, orgId),
        eq(orgPhoneNumbers.status, "active"),
        inArray(orgPhoneNumbers.numberSeries, acceptableSeries),
      ),
    )
    .limit(1);

  if (!compliantNumber) {
    const reason =
      `This org is calling an India number (${toNumber}) but has no active phone number registered ` +
      `under a valid TRAI DLT series (${acceptableSeries.join("/")}-series) for its vertical — ` +
      `commercial/telemarketing calls in India require a DLT-registered number. See ` +
      `docs/merchant-dlt-onboarding.md, or register this number's series in the dashboard's Numbers page.`;
    console.warn(`[compliance] blocked outbound call — org ${orgId} has no ${acceptableSeries.join("/")}-series number for India dial to ${toNumber}`);
    return { allowed: false, reason };
  }
  return { allowed: true };
}
