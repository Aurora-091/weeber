import type { WorkflowGraph } from "./graph-types";

/**
 * The standard Shopify cart recovery workflow — 3 call attempts with
 * escalating discounts (0% → 10% → 20%), matching the Klaviyo-style
 * "email 1 = no discount, email 2 = 10%, email 3 = 20%" pattern.
 */
export const CART_RECOVERY_GRAPH: WorkflowGraph = {
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 400, y: 0 },
      config: { event: "checkout_abandoned" },
    },
    {
      id: "wait-1",
      type: "wait",
      position: { x: 400, y: 100 },
      config: { delayMinutes: 45 },
    },
    {
      id: "call-1",
      type: "call",
      position: { x: 400, y: 200 },
      config: {
        persona: "shopify-cart-recovery",
        discountPercent: 0,
      },
    },
    {
      id: "split-1",
      type: "conditionalSplit",
      position: { x: 400, y: 320 },
      config: {
        outcomes: ["interested", "no-answer", "busy", "failed", "not-interested"],
      },
    },
    // -- Second attempt branch (no-answer/busy/failed) --
    {
      id: "wait-2",
      type: "wait",
      position: { x: 650, y: 420 },
      config: { delayMinutes: 360 },
    },
    {
      id: "call-2",
      type: "call",
      position: { x: 650, y: 520 },
      config: {
        persona: "shopify-cart-recovery",
        discountPercent: { "2": 10 },
      },
    },
    {
      id: "split-2",
      type: "conditionalSplit",
      position: { x: 650, y: 640 },
      config: {
        outcomes: ["interested", "no-answer", "busy", "failed", "not-interested"],
      },
    },
    // -- Third attempt branch --
    {
      id: "wait-3",
      type: "wait",
      position: { x: 900, y: 740 },
      config: { delayMinutes: 1440 },
    },
    {
      id: "call-3",
      type: "call",
      position: { x: 900, y: 840 },
      config: {
        persona: "shopify-cart-recovery",
        discountPercent: { "3": 20 },
      },
    },
    {
      id: "split-3",
      type: "conditionalSplit",
      position: { x: 900, y: 960 },
      config: {
        outcomes: ["interested", "no-answer", "not-interested"],
      },
    },
    // -- Terminal nodes --
    {
      id: "dnc-exhausted",
      type: "addToDnc",
      position: { x: 1100, y: 1060 },
      config: { reason: "cart recovery exhausted" },
    },
    {
      id: "dnc-declined",
      type: "addToDnc",
      position: { x: 150, y: 420 },
      config: { reason: "declined cart recovery" },
    },
  ],
  edges: [
    { id: "e-trigger-wait1", source: "trigger-1", target: "wait-1" },
    { id: "e-wait1-call1", source: "wait-1", target: "call-1" },
    { id: "e-call1-split1", source: "call-1", target: "split-1" },

    // Split 1 branches
    { id: "e-split1-noanswer", source: "split-1", target: "wait-2", branch: "no-answer" },
    { id: "e-split1-busy", source: "split-1", target: "wait-2", branch: "busy" },
    { id: "e-split1-failed", source: "split-1", target: "wait-2", branch: "failed" },
    { id: "e-split1-notinterested", source: "split-1", target: "dnc-declined", branch: "not-interested" },
    { id: "e-split1-default", source: "split-1", target: "wait-2", branch: "default" },

    // Second attempt
    { id: "e-wait2-call2", source: "wait-2", target: "call-2" },
    { id: "e-call2-split2", source: "call-2", target: "split-2" },

    // Split 2 branches
    { id: "e-split2-noanswer", source: "split-2", target: "wait-3", branch: "no-answer" },
    { id: "e-split2-busy", source: "split-2", target: "wait-3", branch: "busy" },
    { id: "e-split2-failed", source: "split-2", target: "wait-3", branch: "failed" },
    { id: "e-split2-notinterested", source: "split-2", target: "dnc-declined", branch: "not-interested" },
    { id: "e-split2-default", source: "split-2", target: "wait-3", branch: "default" },

    // Third attempt
    { id: "e-wait3-call3", source: "wait-3", target: "call-3" },
    { id: "e-call3-split3", source: "call-3", target: "split-3" },

    // Split 3 branches — final attempt, all non-interested paths exhaust
    { id: "e-split3-noanswer", source: "split-3", target: "dnc-exhausted", branch: "no-answer" },
    { id: "e-split3-notinterested", source: "split-3", target: "dnc-declined", branch: "not-interested" },
    { id: "e-split3-default", source: "split-3", target: "dnc-exhausted", branch: "default" },
  ],
};

export const CART_RECOVERY_TEMPLATE = {
  id: "shopify-cart-recovery-v1",
  vertical: "shopify",
  name: "Cart Recovery",
  graph: CART_RECOVERY_GRAPH,
} as const;

/**
 * COD Confirmation workflow (2026-07-19) — trigger `order_placed`.
 *
 * Replaces the hardcoded single-scheduledCall COD path (integrations/shopify
 * orders/create) with an editable, forkable graph. Mirrors the legacy
 * behaviour's intent (confirm a Cash-on-Delivery order while intent is fresh
 * to cut RTO — SHOPIFY_COD defaults: fire instantly, up to 3 attempts, 30-min
 * retry) but makes every step visible and tweakable in the canvas:
 *
 *   call → confirmed?           → notify merchant "confirmed", done
 *        → wants to cancel      → notify merchant "cancel requested", done
 *        → callback requested   → wait 30m → call again
 *        → no-answer/busy/fail  → SMS confirm link → wait 30m → call again
 *   call-2 → confirmed / cancel → same terminal webhooks
 *          → still unreachable  → notify merchant "unconfirmed — review", done
 *
 * v4-compliant: the ONLY path out of the trigger passes through the locked
 * dncCheck + callingWindowCheck nodes, so every downstream call/sms is
 * compliance-gated and the graph survives validateLockedNodesEnforced when a
 * merchant forks and re-saves it.
 */
export const COD_CONFIRMATION_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "trigger-1", type: "trigger", position: { x: 400, y: 0 }, config: { event: "order_placed" } },
    { id: "dnc-1", type: "dncCheck", position: { x: 400, y: 100 }, config: {}, locked: true },
    { id: "window-1", type: "callingWindowCheck", position: { x: 400, y: 200 }, config: {}, locked: true },
    {
      id: "call-1",
      type: "call",
      position: { x: 400, y: 300 },
      config: { persona: "shopify-cod-confirmation", discountPercent: 0 },
    },
    {
      id: "split-1",
      type: "conditionalSplit",
      position: { x: 400, y: 420 },
      config: { outcomes: ["interested", "not-interested", "callback-requested", "no-answer", "busy", "failed"] },
    },
    // Retry branch (no-answer/busy/failed): nudge by SMS, wait, then re-call.
    {
      id: "sms-1",
      type: "sms",
      position: { x: 650, y: 520 },
      config: {
        template:
          "Hi {{customer_name}}, this is {{shop_name}}. Please confirm your Cash on Delivery order so we can ship it — reply YES to confirm. We'll try you again shortly.",
      },
    },
    { id: "wait-retry", type: "wait", position: { x: 650, y: 620 }, config: { delayMinutes: 30 } },
    // Callback-requested branch: just wait, no SMS.
    { id: "wait-cb", type: "wait", position: { x: 900, y: 520 }, config: { delayMinutes: 30 } },
    {
      id: "call-2",
      type: "call",
      position: { x: 750, y: 720 },
      config: { persona: "shopify-cod-confirmation", discountPercent: 0 },
    },
    {
      id: "split-2",
      type: "conditionalSplit",
      position: { x: 750, y: 840 },
      config: { outcomes: ["interested", "not-interested", "no-answer", "busy", "failed"] },
    },
    // Terminal webhooks — fire to the org's configured webhook (WEBHOOK_URL /
    // per-call override); no-op if the merchant hasn't wired one yet. The
    // workflow_action field distinguishes them since the engine always sends
    // the "call.completed" event type.
    {
      id: "webhook-confirmed",
      type: "webhook",
      position: { x: 150, y: 620 },
      config: { url: "", payloadTemplate: { workflow_action: "cod_confirmed", to_number: "{{to_number}}" } },
    },
    {
      id: "webhook-cancel",
      type: "webhook",
      position: { x: 150, y: 720 },
      config: { url: "", payloadTemplate: { workflow_action: "cod_cancel_requested", to_number: "{{to_number}}" } },
    },
    {
      id: "webhook-unconfirmed",
      type: "webhook",
      position: { x: 950, y: 940 },
      config: { url: "", payloadTemplate: { workflow_action: "cod_unconfirmed", to_number: "{{to_number}}" } },
    },
  ],
  edges: [
    { id: "e-trigger-dnc", source: "trigger-1", target: "dnc-1" },
    { id: "e-dnc-window", source: "dnc-1", target: "window-1" },
    { id: "e-window-call1", source: "window-1", target: "call-1" },
    { id: "e-call1-split1", source: "call-1", target: "split-1" },

    // Split 1
    { id: "e-s1-interested", source: "split-1", target: "webhook-confirmed", branch: "interested" },
    { id: "e-s1-cancel", source: "split-1", target: "webhook-cancel", branch: "not-interested" },
    { id: "e-s1-callback", source: "split-1", target: "wait-cb", branch: "callback-requested" },
    { id: "e-s1-noanswer", source: "split-1", target: "sms-1", branch: "no-answer" },
    { id: "e-s1-busy", source: "split-1", target: "sms-1", branch: "busy" },
    { id: "e-s1-failed", source: "split-1", target: "sms-1", branch: "failed" },
    { id: "e-s1-default", source: "split-1", target: "sms-1", branch: "default" },

    // Retry path -> second call
    { id: "e-sms1-wait", source: "sms-1", target: "wait-retry" },
    { id: "e-waitretry-call2", source: "wait-retry", target: "call-2" },
    { id: "e-waitcb-call2", source: "wait-cb", target: "call-2" },
    { id: "e-call2-split2", source: "call-2", target: "split-2" },

    // Split 2 — final
    { id: "e-s2-interested", source: "split-2", target: "webhook-confirmed", branch: "interested" },
    { id: "e-s2-cancel", source: "split-2", target: "webhook-cancel", branch: "not-interested" },
    { id: "e-s2-noanswer", source: "split-2", target: "webhook-unconfirmed", branch: "no-answer" },
    { id: "e-s2-busy", source: "split-2", target: "webhook-unconfirmed", branch: "busy" },
    { id: "e-s2-failed", source: "split-2", target: "webhook-unconfirmed", branch: "failed" },
    { id: "e-s2-default", source: "split-2", target: "webhook-unconfirmed", branch: "default" },
  ],
};

export const COD_CONFIRMATION_TEMPLATE = {
  id: "shopify-cod-confirmation-v1",
  vertical: "shopify",
  name: "COD Confirmation",
  graph: COD_CONFIRMATION_GRAPH,
} as const;

/**
 * Post-Delivery Feedback workflow (2026-07-19) — trigger `order_fulfilled`.
 *
 * Replaces the hardcoded single-scheduledCall feedback path. Legacy behaviour:
 * one call, no retry, ~3 days after fulfilment (SHOPIFY_FEEDBACK_DELAY_DAYS).
 * The graph keeps that shape and adds branch-aware follow-up:
 *
 *   wait 3 days → call → happy (interested)      → SMS review link, done
 *                      → unhappy (not-interested) → notify merchant to follow up
 *                      → no-answer/busy/failed    → SMS feedback link, done
 *
 * No aggressive re-dialling — a missed feedback call just falls back to an SMS
 * link rather than calling again. v4-compliant (locked nodes gate the call).
 */
export const FEEDBACK_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "trigger-1", type: "trigger", position: { x: 400, y: 0 }, config: { event: "order_fulfilled" } },
    { id: "dnc-1", type: "dncCheck", position: { x: 400, y: 100 }, config: {}, locked: true },
    { id: "window-1", type: "callingWindowCheck", position: { x: 400, y: 200 }, config: {}, locked: true },
    // 3 days after fulfilment — long enough that the customer has received and
    // used the product (matches SHOPIFY_FEEDBACK_DELAY_DAYS default of 3).
    { id: "wait-1", type: "wait", position: { x: 400, y: 300 }, config: { delayMinutes: 4320 } },
    {
      id: "call-1",
      type: "call",
      position: { x: 400, y: 400 },
      config: { persona: "shopify-feedback", discountPercent: 0 },
    },
    {
      id: "split-1",
      type: "conditionalSplit",
      position: { x: 400, y: 520 },
      config: { outcomes: ["interested", "not-interested", "no-answer", "busy", "failed"] },
    },
    {
      id: "sms-happy",
      type: "sms",
      position: { x: 150, y: 620 },
      config: {
        template:
          "Thanks for the feedback, {{customer_name}}! If you have a moment, we'd love a quick review from you — {{shop_name}} appreciates it.",
      },
    },
    {
      id: "sms-missed",
      type: "sms",
      position: { x: 650, y: 620 },
      config: {
        template:
          "Hi {{customer_name}}, {{shop_name}} here — we'd love to hear how your recent order went. Reply here anytime with your feedback!",
      },
    },
    {
      id: "webhook-unhappy",
      type: "webhook",
      position: { x: 400, y: 640 },
      config: { url: "", payloadTemplate: { workflow_action: "feedback_unhappy", to_number: "{{to_number}}" } },
    },
  ],
  edges: [
    { id: "e-trigger-dnc", source: "trigger-1", target: "dnc-1" },
    { id: "e-dnc-window", source: "dnc-1", target: "window-1" },
    { id: "e-window-wait", source: "window-1", target: "wait-1" },
    { id: "e-wait-call1", source: "wait-1", target: "call-1" },
    { id: "e-call1-split1", source: "call-1", target: "split-1" },

    { id: "e-s1-happy", source: "split-1", target: "sms-happy", branch: "interested" },
    { id: "e-s1-unhappy", source: "split-1", target: "webhook-unhappy", branch: "not-interested" },
    { id: "e-s1-noanswer", source: "split-1", target: "sms-missed", branch: "no-answer" },
    { id: "e-s1-busy", source: "split-1", target: "sms-missed", branch: "busy" },
    { id: "e-s1-failed", source: "split-1", target: "sms-missed", branch: "failed" },
    { id: "e-s1-default", source: "split-1", target: "sms-missed", branch: "default" },
  ],
};

export const FEEDBACK_TEMPLATE = {
  id: "shopify-feedback-v1",
  vertical: "shopify",
  name: "Post-Delivery Feedback",
  graph: FEEDBACK_GRAPH,
} as const;

/** All Shopify workflow templates seeded on boot, in gallery order. */
export const SHOPIFY_WORKFLOW_TEMPLATES = [
  CART_RECOVERY_TEMPLATE,
  COD_CONFIRMATION_TEMPLATE,
  FEEDBACK_TEMPLATE,
] as const;
