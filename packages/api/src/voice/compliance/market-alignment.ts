/**
 * ADR-110 — the market a vertical was authored for, checked against the market
 * actually being dialled.
 *
 * Weeber has a first-class `vertical` axis (ADR-031) and no `market` axis:
 * ADR-095 proposed `orgs.market` and was never implemented — grep the schema and
 * the only `market` is `shopifyContacts.marketingConsent`. So market is inferred,
 * and ADR-095's own complaint was that it is inferred from the *callee's country
 * code*, which is a proxy for the thing we mean.
 *
 * ADR-110 declines to add the column and instead writes down the coupling that
 * is already true in the authored artifacts: the insurance templates are written
 * for the **US** (the final-expense persona is explicitly US-only) and the
 * Shopify templates for **India** (COD confirmation is an India-shaped
 * behaviour). That is a go-to-market focus decision, not a constraint the
 * runtime should enforce.
 *
 * Which is exactly why this module WARNS and never refuses. Two reasons:
 *
 *  1. Refusing shopify→US would bolt the door on the largest Shopify merchant
 *     base on earth to encode a fact that is only true because we have zero
 *     customers. Cart recovery is not India-specific; only COD is. A refusal
 *     here would have to be unpicked by the first US store that asks, by which
 *     time it would be load-bearing.
 *  2. ADR-098's precedent: an absent fact is not a negative fact. "This org's
 *     vertical was authored for another market" is not a legal finding — the
 *     real legal gates (DNC, calling window, FTSA cap, TRAI series, producer
 *     licensing) all key off the destination and the vertical independently and
 *     are unaffected by this module.
 *
 * So the output is a greppable log line and a value the dashboard can render.
 * Nothing in `runOutboundGates` branches on it.
 */

/** The markets Weeber has authored agent content for. Deliberately not an
 * `orgs.market` column — see the file header and ADR-110. */
export type Market = "india" | "us";

export type CalleeMarket = Market | "unknown";

/**
 * Which market each vertical's templates were authored for.
 *
 * A `Partial` map on purpose: a vertical with no entry is one we have not made
 * this claim about, and the correct output there is `unknown-vertical`, not a
 * default that silently asserts a market nobody chose. `orgs.vertical` is
 * `text().notNull()` with no DB-level enum or check constraint — only
 * `PATCH /api/app/settings` validates the two known values — so an unrecognised
 * vertical is reachable and must not fall through to a guess.
 */
export const AUTHORED_MARKET_BY_VERTICAL: Partial<Record<string, Market>> = {
  insurance: "us",
  shopify: "india",
};

/**
 * Callee market from the E.164 prefix. Same technique the calling-window
 * resolver uses (`isIndianNumber`), and it carries the same known limitation,
 * stated here rather than assumed: ported, VOIP and diaspora numbers
 * misclassify. That is tolerable precisely because nothing enforces on this —
 * had this decided a refusal, the prefix would not be a good enough input.
 *
 * `unknown` for everything that is neither +91 nor NANP, rather than folding the
 * rest into "us" the way `checkCallingWindow` does. That fold is right for a
 * calling window (some window must be picked) and wrong here: claiming a German
 * number is a US-market call would be inventing the fact this module exists to
 * report.
 */
export function resolveCalleeMarket(e164: string): CalleeMarket {
  if (/^\+91\d{10}$/.test(e164)) return "india";
  if (/^\+1\d{10}$/.test(e164)) return "us";
  return "unknown";
}

export type MarketAlignment =
  | { aligned: true; market: CalleeMarket }
  | {
      aligned: false;
      reason: "market-mismatch" | "unknown-callee-market" | "unknown-vertical";
      vertical: string;
      authoredMarket: Market | null;
      calleeMarket: CalleeMarket;
      /** One line, safe to log and to render. Never spoken to a caller. */
      message: string;
    };

/**
 * Pure. Takes the vertical and the destination and says whether this dial is
 * inside the market its agent content was written for.
 *
 * Never throws and never refuses — callers treat a non-aligned result as
 * information. Keeping it pure (no `db`, unlike every other file in this
 * directory) is what lets it be called from the dial path and from a read model
 * without a second copy of the rule.
 */
export function checkVerticalMarketAlignment(vertical: string, toNumber: string): MarketAlignment {
  const calleeMarket = resolveCalleeMarket(toNumber);
  const authoredMarket = AUTHORED_MARKET_BY_VERTICAL[vertical] ?? null;

  if (authoredMarket === null) {
    return {
      aligned: false,
      reason: "unknown-vertical",
      vertical,
      authoredMarket: null,
      calleeMarket,
      message:
        `Vertical "${vertical}" has no authored market on record, so this call's agent content ` +
        `cannot be checked against its destination. Every vertical-scoped compliance gate still ran.`,
    };
  }

  if (calleeMarket === "unknown") {
    return {
      aligned: false,
      reason: "unknown-callee-market",
      vertical,
      authoredMarket,
      calleeMarket,
      message:
        `This number is outside both markets Weeber has authored agent content for ` +
        `(India, US), so the ${vertical} agent is running outside the market it was written for. ` +
        `Wording, currency and disclosures may not fit.`,
    };
  }

  if (calleeMarket !== authoredMarket) {
    return {
      aligned: false,
      reason: "market-mismatch",
      vertical,
      authoredMarket,
      calleeMarket,
      message:
        `The ${vertical} agents are authored for the ${authoredMarket.toUpperCase()} market, but this ` +
        `call is to a ${calleeMarket.toUpperCase()} number. The call is allowed and every compliance ` +
        `gate still ran — but the persona, currency and disclosures were written for ` +
        `${authoredMarket.toUpperCase()} and may read wrong.`,
    };
  }

  return { aligned: true, market: calleeMarket };
}

/**
 * The side effect, kept separate from the decision so the decision stays pure
 * and testable without capturing console output.
 *
 * `console.warn` and not a `guardrail_events` row: a row implies something the
 * product refused or scrubbed, and this refused nothing. If mismatch volume ever
 * becomes a number worth trending, that is the moment to persist it — not
 * before, on zero customers.
 */
export function warnOnMarketMisalignment(
  orgId: string | null | undefined,
  vertical: string,
  toNumber: string,
): MarketAlignment {
  const alignment = checkVerticalMarketAlignment(vertical, toNumber);
  if (!alignment.aligned) {
    console.warn("[compliance] outbound call is outside its vertical's authored market", {
      orgId: orgId ?? null,
      vertical,
      to: toNumber,
      reason: alignment.reason,
      authoredMarket: alignment.authoredMarket,
      calleeMarket: alignment.calleeMarket,
      message: alignment.message,
    });
  }
  return alignment;
}
