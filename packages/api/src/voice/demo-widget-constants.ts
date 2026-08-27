/**
 * Shared constants for the real demo-call widget (2026-08-27,
 * docs/product-strategy/real-demo-call-widget-plan-2026-08-26.md). One place so the seed script,
 * the public endpoint, the one-off provisioning script, and the admin page all agree on the same
 * org id / flag key / agent list — a typo'd duplicate string in any one of them would silently
 * misroute a real phone call.
 */

/** Fixed, human-readable id (not a random uuid) — this org is created once by seed.ts, never
 * through the normal signup flow, so a stable id is easier to grep/reference than a generated one. */
export const DEMO_ORG_ID = "weeber-live-demo";

/** Global kill switch (`feature_flags.orgId === ""`). Seeded disabled; flip only after Phase 1/2
 * are verified end-to-end. See voice/demo-widget-flag.ts's `isDemoWidgetEnabled`. */
export const DEMO_WIDGET_FLAG_KEY = "demo-widget-enabled";

export type DemoAgentKey = "insurance-final-expense-qualifier" | "shopify-cod-confirmation" | "weeber-pitch-agent";

export const DEMO_AGENT_KEYS: readonly DemoAgentKey[] = [
  "insurance-final-expense-qualifier",
  "shopify-cod-confirmation",
  "weeber-pitch-agent",
];

/** `consentRecords.version` for every consent row this flow writes — bump if /terms' substance
 * changes in a way that would matter for an audit of past consents. */
export const DEMO_WIDGET_CONSENT_VERSION = "demo-widget-v1";

/** Reads a positive integer from an env var, falling back when unset/invalid — lets the rate-limit
 * tiers below be tuned per-environment (e.g. raised for a testing pass) via a Railway env var
 * change + restart, with no code deploy needed. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Rate-limit tiers (user-confirmed defaults, 2026-08-27 planning session) — each independently
 * overridable via env var for a testing pass without touching code. Unset = the conservative
 * launch defaults below. */
export const DEMO_WIDGET_RATE_LIMITS = {
  perIpPerDay: envInt("DEMO_WIDGET_MAX_PER_IP_PER_DAY", 2),
  perPhonePerDay: envInt("DEMO_WIDGET_MAX_PER_PHONE_PER_DAY", 1),
  globalPerDay: envInt("DEMO_WIDGET_MAX_GLOBAL_PER_DAY", 50),
} as const;

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
