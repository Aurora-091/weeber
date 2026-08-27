/**
 * Real demo-call widget (2026-08-27) — business logic for the public
 * `POST /api/public/demo-call` endpoint, kept separate from its Hono glue in `public-routes.ts`
 * (same split as `waitlist.ts`). A visitor picks one of three demo agents, gets a real outbound
 * PSTN call placed through the same `placeOutboundCall` every merchant call goes through — so DNC/
 * TCPA/FTSA compliance is inherited automatically (see voice/place-outbound-call.ts's ADR-096
 * doc comment), not reimplemented here.
 *
 * Guardrails, in order (source plan: docs/product-strategy/real-demo-call-widget-plan-2026-08-26.md).
 * Honeypot lives in public-routes.ts (an HTTP-layer concern — it needs to return a disguised 2xx,
 * which belongs with the rest of that route's response shaping):
 *   1. Kill switch (`demo-widget-flag.ts`) — fails closed.
 *   2. `agentKey` is one of the three seeded demo templates.
 *   3. Explicit consent.
 *   4. Turnstile verification — fails closed, but skipped entirely while unconfigured (no
 *      Cloudflare keys yet, 2026-08-27 — see isTurnstileConfigured's doc comment).
 *   5. Phone normalization.
 *   6-8. Per-IP / per-phone / global daily rate limits.
 *   9. Consent record (with IP/UA — the flow's actual audit trail, since consent here is
 *      checkbox-only with no number-ownership verification, an accepted risk — see the source plan).
 *   10. `placeOutboundCall`.
 *
 * Consent is written via a direct `db.insert`, not `@weeber/compliance`'s
 * `createConsentAdapterForOrg(...).grant()` — that adapter's `ConsentRecord` type has no
 * IP/user-agent fields, and extending it would touch the compliance package for a shape only this
 * flow needs. `packages/weeber-compliance` stays untouched by this feature.
 */
import { db } from "../database";
import { consentRecords } from "../database/schema";
import { placeOutboundCall } from "../voice/place-outbound-call";
import { normalizePhone } from "../voice/leads/csv-import";
import { makeFixedWindowLimiter } from "../voice/fixed-window-limiter";
import { checkAndIncrementKeyedRateLimit } from "../database/rate-limit-store";
import { verifyTurnstileToken, isTurnstileConfigured } from "../voice/turnstile";
import { isGlobalFlagEnabled } from "../voice/demo-widget-flag";
import {
  DEMO_AGENT_KEYS,
  DEMO_ORG_ID,
  DEMO_WIDGET_CONSENT_VERSION,
  DEMO_WIDGET_FLAG_KEY,
  DEMO_WIDGET_RATE_LIMITS,
  ONE_DAY_MS,
  type DemoAgentKey,
} from "../voice/demo-widget-constants";

export type DemoCallInput = {
  agentKey: unknown;
  phone: unknown;
  consent: unknown;
  turnstileToken: unknown;
  ip: string;
  userAgent: string | null;
};

export type DemoCallResult =
  | { ok: true; sessionKey: string; status: string }
  | { ok: false; error: string; statusCode: 400 | 403 | 429 | 500 | 502 };

// Per-IP, process-local — same tier/tradeoff as public-routes.ts's other fixed-window limiters
// (resets on restart; the least safety-critical of this endpoint's three rate-limit tiers since
// the per-phone and global caps below are Postgres-backed and actually bound TCPA/cost risk).
const ipLimiter = makeFixedWindowLimiter(ONE_DAY_MS, DEMO_WIDGET_RATE_LIMITS.perIpPerDay);

function isDemoAgentKey(value: unknown): value is DemoAgentKey {
  return typeof value === "string" && (DEMO_AGENT_KEYS as readonly string[]).includes(value);
}

export async function placeDemoCall(input: DemoCallInput): Promise<DemoCallResult> {
  const { agentKey, phone, consent, turnstileToken, ip, userAgent } = input;

  const enabled = await isGlobalFlagEnabled(DEMO_WIDGET_FLAG_KEY);
  if (!enabled) {
    return { ok: false, error: "Demo calls are temporarily unavailable. Please check back soon.", statusCode: 403 };
  }

  if (!isDemoAgentKey(agentKey)) {
    return { ok: false, error: "`agentKey` must be one of the available demo agents.", statusCode: 400 };
  }

  if (consent !== true) {
    return { ok: false, error: "Consent is required before we can place the call.", statusCode: 400 };
  }

  // 2026-08-27: no Cloudflare Turnstile site/secret key pair exists yet — skip verification
  // entirely rather than fail-closed-forever on an unconfigured feature (that fail-closed
  // behavior is for a configured secret whose verify call goes wrong, not for "never set up").
  // Re-enable by setting TURNSTILE_SECRET_KEY (and the frontend's VITE_TURNSTILE_SITE_KEY) —
  // no code change needed, this gate flips on by itself once both keys exist.
  if (isTurnstileConfigured()) {
    if (typeof turnstileToken !== "string" || !turnstileToken) {
      return { ok: false, error: "Verification failed. Please try again.", statusCode: 400 };
    }
    const verified = await verifyTurnstileToken(turnstileToken, ip);
    if (!verified) {
      return { ok: false, error: "Verification failed. Please try again.", statusCode: 400 };
    }
  }

  if (typeof phone !== "string" || !phone.trim()) {
    return { ok: false, error: "`phone` is required.", statusCode: 400 };
  }
  const normalizedPhone = normalizePhone(phone.trim());
  if (!normalizedPhone) {
    return {
      ok: false,
      error: "Could not parse that phone number. Please include a country code, e.g. +1 415 555 1234.",
      statusCode: 400,
    };
  }

  if (ipLimiter(ip)) {
    return { ok: false, error: "Too many demo requests from this network today. Please try again tomorrow.", statusCode: 429 };
  }
  const phoneCheck = await checkAndIncrementKeyedRateLimit(
    "phone",
    normalizedPhone,
    ONE_DAY_MS,
    DEMO_WIDGET_RATE_LIMITS.perPhonePerDay,
  );
  if (!phoneCheck.allowed) {
    return { ok: false, error: "This phone number has already had a demo call today.", statusCode: 429 };
  }
  const globalCheck = await checkAndIncrementKeyedRateLimit("global", "all", ONE_DAY_MS, DEMO_WIDGET_RATE_LIMITS.globalPerDay);
  if (!globalCheck.allowed) {
    return { ok: false, error: "Demo calls have reached today's limit across all visitors. Please try again tomorrow.", statusCode: 429 };
  }

  await db.insert(consentRecords).values({
    orgId: DEMO_ORG_ID,
    dataPrincipal: normalizedPhone,
    purpose: "marketing",
    channel: "web",
    source: "demo-widget",
    version: DEMO_WIDGET_CONSENT_VERSION,
    ipAddress: ip,
    userAgent,
  });

  const result = await placeOutboundCall({ orgId: DEMO_ORG_ID, to: normalizedPhone, agentKey });
  if (!result.ok) {
    return { ok: false, error: result.error, statusCode: result.statusCode };
  }
  return { ok: true, sessionKey: result.sessionKey, status: result.status };
}
