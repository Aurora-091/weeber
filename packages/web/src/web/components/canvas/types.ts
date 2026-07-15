// Mirror of packages/api/src/voice/workflows/graph-types.ts
// Frontend-local copy to avoid cross-package import

export type WorkflowNodeType =
  | "trigger"
  | "wait"
  | "call"
  | "conditionalSplit"
  | "sms"
  | "addToDnc"
  | "webhook";

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  config: NodeConfig;
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

export type NodeConfig =
  | TriggerConfig
  | WaitConfig
  | CallConfig
  | ConditionalSplitConfig
  | SmsConfig
  | AddToDncConfig
  | WebhookConfig;

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
