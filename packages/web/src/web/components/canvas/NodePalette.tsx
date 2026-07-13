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
import type { WorkflowNodeType } from "./types";

const ICON_MAP = {
  Zap,
  Clock,
  Phone,
  GitBranch,
  MessageSquare,
  ShieldBan,
  Globe,
} as const;

const NODE_TYPES: WorkflowNodeType[] = [
  "trigger",
  "wait",
  "call",
  "conditionalSplit",
  "sms",
  "addToDnc",
  "webhook",
];

export function NodePalette() {
  function onDragStart(event: React.DragEvent, nodeType: WorkflowNodeType) {
    event.dataTransfer.setData("application/workflow-node-type", nodeType);
    event.dataTransfer.effectAllowed = "move";
  }

  return (
    <div className="flex flex-col gap-1 p-3 w-[180px] border-r border-border bg-background">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        Nodes
      </span>
      {NODE_TYPES.map((nodeType) => {
        const style = NODE_STYLES[nodeType];
        const Icon = ICON_MAP[style.icon as keyof typeof ICON_MAP];
        return (
          <div
            key={nodeType}
            draggable
            onDragStart={(e) => onDragStart(e, nodeType)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-grab hover:bg-muted transition-colors"
          >
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium">{style.label}</span>
          </div>
        );
      })}
    </div>
  );
}
