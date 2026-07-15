import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { useUnsavedChanges } from "../../hooks/useUnsavedChanges";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, Save, Loader as Loader2, GitBranch } from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { appPath } from "../../lib/route-base";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Badge } from "../../components/ui/badge";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";
import { WorkflowNode } from "../../components/canvas/WorkflowNode";
import { BranchEdge } from "../../components/canvas/BranchEdge";
import { MERGE_TAGS } from "../../components/canvas/types";
import type { WorkflowGraph, WorkflowNodeType } from "../../components/canvas/types";

type WorkflowResponse = {
  id: string;
  name: string;
  vertical: string;
  graph: WorkflowGraph;
  active: boolean;
  orgConfig: {
    enabled: boolean;
    overrides: Record<string, Record<string, unknown>> | null;
  };
};

const nodeTypes = { workflow: WorkflowNode };
const edgeTypes = { branch: BranchEdge };

function graphToFlow(graph: WorkflowGraph) {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "workflow",
    position: n.position,
    data: { nodeType: n.type, config: n.config, label: n.id },
    draggable: false,
    connectable: false,
  }));
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "branch",
    data: { branch: e.branch },
    label: e.branch || undefined,
  }));
  return { nodes, edges };
}

const EDITABLE_TYPES: WorkflowNodeType[] = ["wait", "call", "sms"];

function UserWorkflowEditorInner({ workflow }: { workflow: WorkflowResponse }) {
  const qc = useQueryClient();
  const { nodes, edges } = useMemo(() => graphToFlow(workflow.graph), [workflow.graph]);
  const [overrides, setOverrides] = useState<Record<string, Record<string, unknown>>>(
    workflow.orgConfig.overrides ?? {},
  );
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  // Tracks whether `overrides` has changed since the last successful save —
  // `save.isSuccess` alone stays true forever after the first save, which
  // would keep showing "Saved" even after a later, still-unsaved edit.
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);

  const editingNode = workflow.graph.nodes.find((n) => n.id === editingNodeId);
  const editingConfig = editingNode
    ? Object.assign({}, editingNode.config as Record<string, unknown>, overrides[editingNode.id])
    : null;

  const setNodeOverride = useCallback((nodeId: string, key: string, value: unknown) => {
    setDirty(true);
    setOverrides((prev) => ({
      ...prev,
      [nodeId]: Object.assign({}, prev[nodeId], { [key]: value }),
    }));
  }, []);

  const save = useMutation({
    mutationFn: async () => {
      const res = await appFetch(`/api/app/workflow-configs/${encodeURIComponent(workflow.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, overrides }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
    },
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["user-workflows"] });
    },
  });

  return (
    <div className="page-enter flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex items-center justify-between gap-3 pb-4 border-b border-border">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href={appPath("/workflows")}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Workflows
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <h1 className="font-medium text-sm truncate">{workflow.name}</h1>
        </div>
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
          {save.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />}
          {!dirty && save.isSuccess ? "Saved" : "Save changes"}
        </Button>
      </div>
      {save.isError && (
        <p className="text-xs text-destructive py-2">{(save.error as Error).message}</p>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={true}
            onNodeClick={(_, node) => {
              const nType = node.data.nodeType as WorkflowNodeType;
              if (EDITABLE_TYPES.includes(nType)) {
                setEditingNodeId(node.id);
              }
            }}
            onPaneClick={() => setEditingNodeId(null)}
            fitView
            className="bg-muted/30"
          >
            <Background gap={20} size={1} />
            <Controls />
            <MiniMap className="!bg-card !border-border" />
          </ReactFlow>
        </div>

        {editingNode && editingConfig && (
          <div className="w-72 border-l border-border overflow-y-auto p-4 space-y-4">
            <h3 className="text-sm font-medium border-b border-border pb-2">
              Edit: {editingNode.type} node
            </h3>

            {editingNode.type === "wait" && (
              <div className="grid gap-1.5">
                <Label>Delay (minutes)</Label>
                <Input
                  type="number"
                  min={1}
                  value={Number(editingConfig.delayMinutes) || 60}
                  onChange={(e) => setNodeOverride(editingNode.id, "delayMinutes", Number(e.target.value))}
                />
                <p className="text-[10px] text-muted-foreground">
                  = {((Number(editingConfig.delayMinutes) || 60) / 60).toFixed(1)} hours
                </p>
              </div>
            )}

            {editingNode.type === "call" && (
              <div className="space-y-3">
                <div className="grid gap-1.5">
                  <Label>Discount %</Label>
                  {typeof editingConfig.discountPercent === "number" ? (
                    <Input
                      type="number"
                      min={0}
                      max={30}
                      value={editingConfig.discountPercent}
                      onChange={(e) => setNodeOverride(editingNode.id, "discountPercent", Number(e.target.value))}
                    />
                  ) : (
                    <div className="space-y-1.5">
                      {Object.entries(
                        (editingConfig.discountPercent ?? {}) as Record<string, number>,
                      ).map(([attempt, pct]) => (
                        <div key={attempt} className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">#{attempt}</span>
                          <Input
                            type="number"
                            min={0}
                            max={30}
                            value={pct}
                            onChange={(e) => {
                              const map = { ...((editingConfig.discountPercent ?? {}) as Record<string, number>) };
                              map[attempt] = Number(e.target.value);
                              setNodeOverride(editingNode.id, "discountPercent", map);
                            }}
                            className="flex-1"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label>Max duration (seconds)</Label>
                  <Input
                    type="number"
                    min={30}
                    value={Number(editingConfig.maxDurationSeconds) || ""}
                    onChange={(e) =>
                      setNodeOverride(editingNode.id, "maxDurationSeconds", e.target.value ? Number(e.target.value) : undefined)
                    }
                    placeholder="Optional"
                  />
                </div>
              </div>
            )}

            {editingNode.type === "sms" && (
              <div className="space-y-3">
                <div className="grid gap-1.5">
                  <Label>Template</Label>
                  <textarea
                    value={(editingConfig.template as string) || ""}
                    onChange={(e) => setNodeOverride(editingNode.id, "template", e.target.value)}
                    rows={4}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm resize-y"
                  />
                </div>
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground mb-1">Merge tags:</p>
                  <div className="flex flex-wrap gap-1">
                    {MERGE_TAGS.map((tag) => (
                      <span key={tag} className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded">
                        {`{{${tag}}}`}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function UserWorkflowsListPage() {
  const workflows = useQuery<{ workflows: WorkflowResponse[] }>({
    queryKey: ["user-workflows"],
    queryFn: async () => {
      const res = await appFetch("/api/app/workflow-configs");
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const rows = workflows.data?.workflows ?? [];

  return (
    <div className="page-enter">
      <PageHeader
        title="Workflows"
        description="Call automation flows for your store. Click a workflow to customize timings and messages."
      />

      {workflows.isLoading && <SkeletonCards count={2} lines={2} />}

      {workflows.isError && (
        <EmptyState
          title="Couldn't load your workflows"
          description="Something went wrong reaching the server — try refreshing the page."
        />
      )}

      {!workflows.isLoading && !workflows.isError && rows.length === 0 && (
        <EmptyState
          title="No workflows available"
          description="Workflow templates will appear here once your store is connected."
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {rows.map((w) => (
          <Link key={w.id} href={appPath(`/workflows/${encodeURIComponent(w.id)}`)}>
            <div className="card-action p-5 h-full">
              <div className="flex items-center gap-2 mb-2">
                <GitBranch className="size-4 text-primary" aria-hidden />
                <span className="font-medium text-sm">{w.name}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary" className="text-[10px]">{w.vertical}</Badge>
                <span>{w.graph.nodes.length} steps</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function UserWorkflowDetailPage() {
  const [, params] = useRoute<{ id: string }>(appPath("/workflows/:id"));
  const id = params?.id ? decodeURIComponent(params.id) : "";

  const workflows = useQuery<{ workflows: WorkflowResponse[] }>({
    queryKey: ["user-workflows"],
    queryFn: async () => {
      const res = await appFetch("/api/app/workflow-configs");
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const workflow = workflows.data?.workflows.find((w) => w.id === id);

  if (workflows.isLoading) return <SkeletonCards count={1} lines={6} />;
  if (workflows.isError) {
    return (
      <EmptyState
        title="Couldn't load this workflow"
        description="Something went wrong reaching the server — try refreshing the page."
      />
    );
  }
  if (!workflow) return <EmptyState title="Workflow not found" description="This workflow doesn't exist." />;

  return (
    <ReactFlowProvider>
      <UserWorkflowEditorInner workflow={workflow} />
    </ReactFlowProvider>
  );
}
