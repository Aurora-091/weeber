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

type NodePaletteProps = {
  onAddNode?: (nodeType: WorkflowNodeType) => void;
};

export function NodePalette({ onAddNode }: NodePaletteProps) {
  function onDragStart(event: React.DragEvent, nodeType: WorkflowNodeType) {
    event.dataTransfer.setData("application/workflow-node-type", nodeType);
    event.dataTransfer.effectAllowed = "move";
  }

  function handleClick(nodeType: WorkflowNodeType) {
    onAddNode?.(nodeType);
  }

  function handleKeyDown(e: React.KeyboardEvent, nodeType: WorkflowNodeType) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onAddNode?.(nodeType);
    }
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
            role="button"
            tabIndex={0}
            aria-label={`Add ${style.label} node to canvas`}
            draggable
            onDragStart={(e) => onDragStart(e, nodeType)}
            onClick={() => handleClick(nodeType)}
            onKeyDown={(e) => handleKeyDown(e, nodeType)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-grab hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors"
          >
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="text-xs font-medium">{style.label}</span>
          </div>
        );
      })}
    </div>
  );
}
