import type { WorkflowNodeType } from "./types";

export type NodeStyle = {
  icon: string;
  color: string;
  label: string;
};

export const NODE_STYLES: Record<WorkflowNodeType, NodeStyle> = {
  trigger: { icon: "Zap", color: "border-l-emerald-500", label: "Trigger" },
  wait: { icon: "Clock", color: "border-l-amber-500", label: "Wait" },
  call: { icon: "Phone", color: "border-l-sky-500", label: "Call" },
  conditionalSplit: { icon: "GitBranch", color: "border-l-violet-500", label: "Split" },
  sms: { icon: "MessageSquare", color: "border-l-pink-500", label: "SMS" },
  addToDnc: { icon: "ShieldBan", color: "border-l-red-500", label: "Add to DNC" },
  webhook: { icon: "Globe", color: "border-l-slate-500", label: "Webhook" },
  // Workflow Canvas v4 (2026-07-18) — locked, pass-through compliance markers.
  dncCheck: { icon: "ShieldCheck", color: "border-l-red-500", label: "DNC Check" },
  callingWindowCheck: { icon: "Clock3", color: "border-l-red-500", label: "Calling Window Check" },
};
