export type WorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  config: NodeConfig;
};

export type WorkflowNodeType =
  | "trigger"
  | "wait"
  | "call"
  | "conditionalSplit"
  | "sms"
  | "addToDnc"
  | "webhook";

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  branch?: string;
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

export type WorkflowBranch = (typeof WORKFLOW_OUTCOMES)[number];

export const MERGE_TAGS = [
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
] as const;

export type MergeTag = (typeof MERGE_TAGS)[number];
