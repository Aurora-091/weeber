import { eq, and } from "drizzle-orm";
import { db } from "../database";
import { orgAgentConfigs } from "../database/schema";

/**
 * Per-org retry cadence — issue 3 feature. Three explicit knobs (delay
 * before the first call, delay between retry attempts, max attempts),
 * overridable per (orgId, templateKey) via org_agent_configs, falling back
 * to sane platform defaults when an org has no override. Deliberately no
 * customer-driven reschedule override on top of these.
 *
 * The platform defaults here match what integrations/shopify/routes.ts's
 * SHOPIFY_*_DELAY_MINUTES/SHOPIFY_*_MAX_ATTEMPTS env vars defaulted to
 * before this feature existed — this module doesn't remove those env vars
 * (they're still the fallback-of-the-fallback via getRetryDefaults' own
 * defaults, read once here instead of scattered across call sites), it
 * just makes them overridable per org.
 */
export type RetryConfig = {
  firstCallDelayMinutes: number;
  retryDelayMinutes: number;
  maxAttempts: number;
};

const PLATFORM_DEFAULTS: Record<string, RetryConfig> = {
  "shopify-cart-recovery": {
    // Fires the instant the trigger fires by default (2026-07-16, explicit
    // user decision) — was 45min. Still fully overridable per-org on the
    // agent's Calling & Model tab if a merchant wants a delay instead.
    firstCallDelayMinutes: Number(process.env.SHOPIFY_CART_RECOVERY_DELAY_MINUTES ?? 0),
    retryDelayMinutes: Number(process.env.SHOPIFY_CART_RECOVERY_RETRY_DELAY_MINUTES ?? 60),
    maxAttempts: Number(process.env.SHOPIFY_CART_RECOVERY_MAX_ATTEMPTS ?? 2),
  },
  "shopify-cod-confirmation": {
    // Same instant-by-default change — confirming a COD order while intent
    // is still fresh directly reduces RTO, the whole point of this agent.
    firstCallDelayMinutes: Number(process.env.SHOPIFY_COD_DELAY_MINUTES ?? 0),
    retryDelayMinutes: Number(process.env.SHOPIFY_COD_RETRY_DELAY_MINUTES ?? 30),
    maxAttempts: Number(process.env.SHOPIFY_COD_MAX_ATTEMPTS ?? 3),
  },
  "shopify-feedback": {
    // Feedback calls don't retry (see routes.ts: maxAttempts is hardcoded to
    // 1 there, a missed feedback call just means no feedback this time) —
    // retryDelayMinutes is irrelevant but kept for shape consistency.
    firstCallDelayMinutes: Number(process.env.SHOPIFY_FEEDBACK_DELAY_DAYS ?? 3) * 24 * 60,
    retryDelayMinutes: 0,
    maxAttempts: 1,
  },
};

/** Fallback for any templateKey without a specific default above (shouldn't happen for Shopify's 3 known templates, but keeps this total rather than throwing). */
const GENERIC_DEFAULT: RetryConfig = { firstCallDelayMinutes: 30, retryDelayMinutes: 30, maxAttempts: 3 };

export function getRetryDefaults(templateKey: string): RetryConfig {
  return PLATFORM_DEFAULTS[templateKey] ?? GENERIC_DEFAULT;
}

/**
 * Resolves the effective retry config for an org+template: org override
 * fields win individually (a merchant can override just maxAttempts and
 * leave the delays at platform defaults, for example), falling back to
 * getRetryDefaults() per-field for anything unset.
 */
export async function resolveRetryConfig(orgId: string | undefined, templateKey: string): Promise<RetryConfig> {
  const defaults = getRetryDefaults(templateKey);
  if (!orgId) return defaults;

  const [row] = await db
    .select({
      firstCallDelayMinutes: orgAgentConfigs.firstCallDelayMinutes,
      retryDelayMinutes: orgAgentConfigs.retryDelayMinutes,
      maxAttempts: orgAgentConfigs.maxAttempts,
    })
    .from(orgAgentConfigs)
    .where(and(eq(orgAgentConfigs.orgId, orgId), eq(orgAgentConfigs.templateKey, templateKey)))
    .limit(1);

  if (!row) return defaults;

  return {
    firstCallDelayMinutes: row.firstCallDelayMinutes ?? defaults.firstCallDelayMinutes,
    retryDelayMinutes: row.retryDelayMinutes ?? defaults.retryDelayMinutes,
    maxAttempts: row.maxAttempts ?? defaults.maxAttempts,
  };
}

/** Shopify's three built-in vertical workflow names — used by workflows/engine.ts to decide whether a call belongs to the org-scoped retry path below, or the generic WORKFLOWS-env-var path. */
export function isShopifyWorkflow(workflowName: string | undefined | null): boolean {
  return Boolean(workflowName && workflowName.startsWith("shopify-"));
}
