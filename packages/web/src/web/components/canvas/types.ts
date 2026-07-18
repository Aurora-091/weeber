// Mirror of packages/api/src/voice/workflows/graph-types.ts
// Frontend-local copy to avoid cross-package import

export type WorkflowNodeType =
  | "trigger"
  | "wait"
  | "call"
  | "conditionalSplit"
  | "sms"
  | "addToDnc"
  | "webhook"
  // Workflow Canvas v4 (2026-07-18) — pass-through nodes that make the
  // always-enforced-underneath DNC/calling-window checks visible in the
  // authoring UI. See packages/api/src/voice/workflows/graph-types.ts's
  // matching comment for the full reasoning.
  | "dncCheck"
  | "callingWindowCheck";

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  config: NodeConfig;
  // Workflow Canvas v4 (2026-07-18) — true for system-seeded compliance
  // nodes a merchant can see but not delete/reconfigure. UI-level only; the
  // real guarantee is server-side (scaffold.ts's validateLockedNodesEnforced
  // on save, and scheduler.ts's dispatchScheduledCall at execution time).
  locked?: boolean;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  branch?: string;
};

export type WorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type TriggerConfig = {
  event: "checkout_abandoned" | "order_placed" | "order_fulfilled";
};

export type WaitConfig = {
  delayMinutes: number;
};

export type CallConfig = {
  persona: string;
  discountPercent: number | Record<string, number>;
  maxDurationSeconds?: number;
};

export type ConditionalSplitConfig = {
  outcomes: string[];
};

export type SmsConfig = {
  template: string;
};

export type AddToDncConfig = {
  reason: string;
};

export type WebhookConfig = {
  url: string;
  payloadTemplate?: Record<string, string>;
};

/** Empty on purpose — dncCheck/callingWindowCheck carry no merchant-editable
 * config, they're pass-through visual/compliance markers. */
export type ComplianceCheckConfig = Record<string, never>;

export type NodeConfig =
  | TriggerConfig
  | WaitConfig
  | CallConfig
  | ConditionalSplitConfig
  | SmsConfig
  | AddToDncConfig
  | WebhookConfig
  | ComplianceCheckConfig;

export const WORKFLOW_OUTCOMES = [
  "answered",
  "no-answer",
  "busy",
  "failed",
  "voicemail",
  "interested",
  "not-interested",
  "callback-requested",
  "booked",
  "no-decision",
  "wrong-number",
  "default",
] as const;

export const MERGE_TAGS: Record<string, readonly string[]> = {
  shopify: [
    "customer_name",
    "cart_value",
    "currency",
    "checkout_url",
    "shop_name",
    "attempt_number",
    "discount_percent",
    "discount_code",
    "abandoned_checkout_url",
    "cart_recovery_url",
  ],
  insurance: [
    "customer_name",
    "policy_number",
    "renewal_date",
    "premium_amount",
    "currency",
    "agent_name",
    "attempt_number",
    "to_number",
  ],
  default: [
    "customer_name",
    "attempt_number",
    "to_number",
    "discount_percent",
    "discount_code",
  ],
} as const;
