import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Zap,
  Clock,
  Phone,
  GitBranch,
  MessageSquare,
  ShieldBan,
  Globe,
} from "lucide-react";
import { NODE_STYLES } from "./node-styles";
import type {
  WorkflowNodeType,
  TriggerConfig,
  WaitConfig,
  CallConfig,
  ConditionalSplitConfig,
  SmsConfig,
  AddToDncConfig,
  WebhookConfig,
  NodeConfig,
} from "./types";

const ICON_MAP = {
  Zap,
  Clock,
  Phone,
  GitBranch,
  MessageSquare,
  ShieldBan,
  Globe,
} as const;

type WorkflowNodeData = {
  nodeType: WorkflowNodeType;
  config: NodeConfig;
};

function formatEvent(event: string): string {
  return event
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function getNodeSummary(nodeType: WorkflowNodeType, config: NodeConfig): string {
  switch (nodeType) {
    case "trigger":
      return formatEvent((config as TriggerConfig).event);
    case "wait": {
      const minutes = (config as WaitConfig).delayMinutes;
      return minutes >= 60 ? `Wait ${Math.round(minutes / 60)} hr` : `Wait ${minutes} min`;
    }
    case "call": {
      const c = config as CallConfig;
      const discount =
        typeof c.discountPercent === "number"
          ? `${c.discountPercent}%`
          : Object.values(c.discountPercent).join("/") + "%";
      return `${c.persona} · ${discount}`;
    }
    case "conditionalSplit":
      return `${(config as ConditionalSplitConfig).outcomes.length} outcomes`;
    case "sms": {
      const tmpl = (config as SmsConfig).template;
      return tmpl.length > 40 ? tmpl.slice(0, 40) + "…" : tmpl;
    }
    case "addToDnc":
      return (config as AddToDncConfig).reason;
    case "webhook": {
      const url = (config as WebhookConfig).url;
      return url.length > 30 ? url.slice(0, 30) + "…" : url;
    }
  }
}

export function WorkflowNode({ data }: NodeProps) {
  const { nodeType, config } = data as unknown as WorkflowNodeData;
  const style = NODE_STYLES[nodeType];
  const Icon = ICON_MAP[style.icon as keyof typeof ICON_MAP];

  return (
    <div className={`card-weeber w-[200px] border-l-[3px] ${style.color} p-3`}>
      {nodeType !== "trigger" && (
        <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      )}

      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {style.label}
        </span>
      </div>

      <p className="text-xs font-medium leading-tight truncate">
        {getNodeSummary(nodeType, config)}
      </p>

      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  );
}
