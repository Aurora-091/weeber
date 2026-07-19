/**
 * Recommended default setup per vertical (2026-07-19).
 *
 * The product is template-projection based: picking a vertical instantly
 * *exposes* every active agent/workflow template for it, but an agent only
 * actually runs once an org_agent_configs row exists with enabled=true (see
 * integrations/shopify/routes.ts's dispatch gate + org-queries.ts's
 * enabledAgentCount). Historically the setup wizard shipped every agent
 * toggle OFF, so a brand-new merchant finished onboarding with nothing that
 * would ever place a call — "I have agents but nothing happens."
 *
 * This map defines the curated "just works" starting set per vertical, and
 * `provisionVerticalDefaults` writes exactly those rows (enabled) the first
 * time — idempotently, and WITHOUT clobbering a merchant who has since
 * deliberately toggled something off (onConflictDoNothing, never update).
 *
 * Workflows already default to enabled when no config row exists (the shopify
 * dispatch gate only skips when a row exists AND is disabled), so writing an
 * explicit enabled row here is a no-op for runtime behavior — it exists purely
 * so the management surface can show an explicit, owned "on" state instead of
 * an implicit default.
 */

export type VerticalDefaults = {
  /** org_agent_configs.templateKey values to enable by default. */
  agents: string[];
  /** workflow_templates.id values (= org_workflow_configs.templateKey) to enable by default. */
  workflows: string[];
};

export const RECOMMENDED_DEFAULTS: Record<string, VerticalDefaults> = {
  // GTM wedge. Cart recovery (revenue) + COD confirmation (RTO reduction) are
  // the two core money agents; post-delivery feedback stays available but off
  // by default (opt-in, lowest urgency, and the newest/least-referenced
  // template — see seed.ts). The cart-recovery workflow drives the automated
  // outbound cart-recovery calls.
  shopify: {
    agents: ["shopify-cart-recovery", "shopify-cod-confirmation"],
    workflows: ["shopify-cart-recovery-v1"],
  },
  // Insurance is effectively pre-configured already (explicit user note
  // 2026-07-19) — no auto-enable set defined yet. Empty = provisioning is a
  // no-op for this vertical until its curated set is decided.
  insurance: {
    agents: [],
    workflows: [],
  },
};

export function getRecommendedDefaults(vertical: string): VerticalDefaults {
  return RECOMMENDED_DEFAULTS[vertical] ?? { agents: [], workflows: [] };
}
