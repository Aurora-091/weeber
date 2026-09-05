export type WorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  config: NodeConfig;
  // Workflow Canvas v4 (2026-07-18, Phase 1) — true for system-seeded
  // compliance nodes (dncCheck/callingWindowCheck) in a merchant-owned
  // graph. UI-level protection only (canvas disables delete/disconnect on
  // these) — the real compliance guarantee is unchanged and lives in
  // scheduler.ts's dispatchScheduledCall, which already checks DNC/consent
  // and the calling window before placing any call regardless of how a
  // graph is wired. This flag makes that enforcement *visible* in the
  // authoring UI and lets scaffold.ts's save-time validation reject a
  // graph that routes a call/sms path around these nodes — belt and
  // suspenders, not a replacement for either.
  locked?: boolean;
};

export type WorkflowNodeType =
  | "trigger"
  | "wait"
  | "call"
  | "conditionalSplit"
  | "sms"
  | "addToDnc"
  | "webhook"
  // Workflow Canvas v4 (2026-07-18) — visual/pass-through nodes representing
  // the compliance checks that already happen transparently inside every
  // call/sms dispatch (see scheduler.ts). These carry no config and the
  // engine advances through them immediately (same as a trigger node with
  // exactly one outgoing edge) — they exist to make an always-enforced but
  // previously invisible guarantee visible in the graph, and to give
  // scaffold.ts's validator a concrete node to require on every path.
  | "dncCheck"
  | "callingWindowCheck";

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

/** Empty on purpose — dncCheck/callingWindowCheck carry no merchant-editable
 * config, they're pass-through visual/compliance markers (see WorkflowNodeType). */
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
