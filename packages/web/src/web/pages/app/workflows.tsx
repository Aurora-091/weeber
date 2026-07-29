import { useState, useMemo, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { useUnsavedChanges } from "../../hooks/useUnsavedChanges";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Save, Loader as Loader2, GitBranch, Sparkles, Trash2, LayoutTemplate, FilePlus as FilePlus2, Play } from "lucide-react";
import { toast } from "sonner";
import { FlowPreviewPanel } from "../../components/workflow-preview/FlowPreviewPanel";
import { appFetch } from "../../lib/user-session";
import { appPath } from "../../lib/route-base";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Badge } from "../../components/ui/badge";
import { Switch } from "../../components/ui/switch";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";
import { Breadcrumbs } from "../../components/shell/breadcrumbs";
import { WorkflowNode } from "../../components/canvas/WorkflowNode";
import { BranchEdge } from "../../components/canvas/BranchEdge";
import { NodePalette } from "../../components/canvas/NodePalette";
import { NodeConfigPanel } from "../../components/canvas/NodeConfigPanel";
import { MERGE_TAGS, WORKFLOW_OUTCOMES } from "../../components/canvas/types";
import { NODE_STYLES } from "../../components/canvas/node-styles";
import type { WorkflowGraph, WorkflowNodeType } from "../../components/canvas/types";

function getMergeTagsForVertical(vertical?: string): readonly string[] {
  return MERGE_TAGS[vertical || "shopify"] || MERGE_TAGS.default;
}

type WorkflowResponse = {
  id: string;
  name: string;
  description: string;
  vertical: string;
  graph: WorkflowGraph;
  active: boolean;
  orgConfig: {
    enabled: boolean;
    overrides: Record<string, Record<string, unknown>> | null;
    // Workflow Canvas v4 (2026-07-18) — an org's own fully-owned graph, once
    // they've built or forked one. Undefined/null = still on the standard
    // read-only template view below.
    customGraph?: WorkflowGraph | null;
  };
};

const nodeTypes = { workflow: WorkflowNode };

// Node types that aren't merchant-authored "steps" — the trigger is the entry
// point, dncCheck/callingWindowCheck are locked compliance markers, and
// webhook is a system/terminal hook. Counting them (and any locked node)
// inflated the "N steps" badge on the list card with plumbing a merchant
// never configured. Kept in sync with WorkflowNodeType in canvas/types.ts.
const SYSTEM_NODE_TYPES: WorkflowNodeType[] = ["trigger", "webhook", "dncCheck", "callingWindowCheck"];

function countMerchantSteps(graph: WorkflowGraph): number {
  return graph.nodes.filter((n) => !n.locked && !SYSTEM_NODE_TYPES.includes(n.type)).length;
}
const edgeTypes = { branch: BranchEdge };

// Nodes a merchant can manually add via the palette/drag-drop. Excludes the
// two locked compliance types — those are seeded automatically by the
// scaffold/template fork and are never something a merchant adds more of.
const MERCHANT_LOCKED_EXCLUDED: WorkflowNodeType[] = ["dncCheck", "callingWindowCheck"];

const MERCHANT_DEFAULT_CONFIGS: Record<WorkflowNodeType, unknown> = {
  trigger: { event: "checkout_abandoned" },
  wait: { delayMinutes: 60 },
  call: { persona: "", discountPercent: 0 },
  conditionalSplit: { outcomes: ["no-answer", "interested", "not-interested"] },
  sms: { template: "" },
  addToDnc: { reason: "" },
  webhook: { url: "" },
  dncCheck: {},
  callingWindowCheck: {},
};

function graphToFlowEditable(graph: WorkflowGraph) {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "workflow",
    position: n.position,
    data: { nodeType: n.type, config: n.config, locked: n.locked },
    draggable: !n.locked,
    deletable: !n.locked,
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

function flowToGraphEditable(nodes: Node[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.nodeType as WorkflowNodeType,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      config: n.data.config as Record<string, unknown>,
      ...(n.data.locked ? { locked: true } : {}),
    })) as WorkflowGraph["nodes"],
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.data?.branch ? { branch: e.data.branch as string } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Standard view — read-only graph + per-node value overrides. Unchanged
// behavior for every org that hasn't started customizing with the canvas
// (orgConfig.customGraph is null/undefined) — this is today's product.
// ---------------------------------------------------------------------------

const EDITABLE_TYPES: WorkflowNodeType[] = ["wait", "call", "sms"];

function graphToFlowReadOnly(graph: WorkflowGraph) {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "workflow",
    position: n.position,
    data: { nodeType: n.type, config: n.config, locked: n.locked },
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

function UserWorkflowStandardView({
  workflow,
  onStartCustomizing,
}: {
  workflow: WorkflowResponse;
  onStartCustomizing: (startingGraph: WorkflowGraph) => void;
}) {
  const qc = useQueryClient();
  const { nodes, edges } = useMemo(() => graphToFlowReadOnly(workflow.graph), [workflow.graph]);
  const [overrides, setOverrides] = useState<Record<string, Record<string, unknown>>>(
    workflow.orgConfig.overrides ?? {},
  );
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
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

  const startBlank = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/workflow-configs/blank-scaffold");
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as { graph: WorkflowGraph };
    },
    onSuccess: (data) => onStartCustomizing(data.graph),
  });

  return (
    <div className="page-enter flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex items-center justify-between gap-3 pb-4 border-b border-border">
        <div className="flex items-center gap-3 min-w-0">
          <Breadcrumbs
            className="mb-0"
            items={[
              { label: "Workflows", href: appPath("/workflows") },
              { label: workflow.name },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onStartCustomizing(structuredClone(workflow.graph))}
          >
            <LayoutTemplate className="size-3.5" aria-hidden />
            Customize from this template
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => startBlank.mutate()}
            disabled={startBlank.isPending}
          >
            {startBlank.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FilePlus2 className="size-3.5" aria-hidden />}
            Start blank
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />}
            {!dirty && save.isSuccess ? "Saved" : "Save changes"}
          </Button>
        </div>
      </div>
      {save.isError && <p className="text-xs text-destructive py-2">{(save.error as Error).message}</p>}
      {startBlank.isError && <p className="text-xs text-destructive py-2">Couldn't load a blank starting flow — try again.</p>}

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
              Edit: {NODE_STYLES[editingNode.type].label}
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
                    {getMergeTagsForVertical(workflow.vertical).map((tag) => (
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

// ---------------------------------------------------------------------------
// Canvas editor — full node/edge editing, entered once a merchant clicks
// "Customize from this template" or "Start blank" (or reopens a workflow
// they've already customized). Saves into orgConfig.customGraph, not
// per-node overrides — the engine reads this graph instead of the
// template's once it's set (graph-engine.ts's resolveWorkflowGraph).
// ---------------------------------------------------------------------------

let merchantNodeCounter = 0;

function UserWorkflowCanvasEditor({
  workflow,
  startingGraph,
}: {
  workflow: WorkflowResponse;
  startingGraph: WorkflowGraph;
}) {
  const qc = useQueryClient();
  const initial = useMemo(() => graphToFlowEditable(startingGraph), [startingGraph]);
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChangeRaw] = useEdgesState(initial.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  useUnsavedChanges(dirty);

  const onNodesChange = useCallback<typeof onNodesChangeRaw>(
    (changes) => {
      setDirty(true);
      onNodesChangeRaw(changes);
    },
    [onNodesChangeRaw],
  );
  const onEdgesChange = useCallback<typeof onEdgesChangeRaw>(
    (changes) => {
      setDirty(true);
      onEdgesChangeRaw(changes);
    },
    [onEdgesChangeRaw],
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;

  const onConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const isSplit = sourceNode?.data.nodeType === "conditionalSplit";
      const edge: Edge = {
        ...connection,
        id: `e-${connection.source}-${connection.target}-${Date.now()}`,
        type: "branch",
        data: { branch: isSplit ? "default" : undefined },
      } as Edge;
      setDirty(true);
      setEdges((eds) => addEdge(edge, eds));
    },
    [nodes, setEdges],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const addNodeFromPalette = useCallback(
    (type: WorkflowNodeType) => {
      const viewport = reactFlowInstance?.getViewport();
      const centerX = viewport ? (-viewport.x + 400) / (viewport.zoom || 1) : 250;
      const centerY = viewport ? (-viewport.y + 300) / (viewport.zoom || 1) : 200;
      merchantNodeCounter++;
      const newNode: Node = {
        id: `${type}-${Date.now()}-${merchantNodeCounter}`,
        type: "workflow",
        position: { x: centerX, y: centerY },
        data: { nodeType: type, config: MERCHANT_DEFAULT_CONFIGS[type], label: type },
      };
      setDirty(true);
      setNodes((nds) => [...nds, newNode]);
    },
    [reactFlowInstance, setNodes],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("application/workflow-node-type") as WorkflowNodeType;
      if (!type || !reactFlowInstance || MERCHANT_LOCKED_EXCLUDED.includes(type)) return;
      const position = reactFlowInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      merchantNodeCounter++;
      const newNode: Node = {
        id: `${type}-${Date.now()}-${merchantNodeCounter}`,
        type: "workflow",
        position,
        data: { nodeType: type, config: MERCHANT_DEFAULT_CONFIGS[type], label: type },
      };
      setDirty(true);
      setNodes((nds) => [...nds, newNode]);
    },
    [reactFlowInstance, setNodes],
  );

  const deleteSelected = useCallback(() => {
    if (selectedNodeId) {
      const target = nodes.find((n) => n.id === selectedNodeId);
      if (target?.data?.locked) {
        setSelectedNodeId(null);
        return;
      }
      setDirty(true);
      setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
      setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
      setSelectedNodeId(null);
    }
    if (selectedEdgeId) {
      setDirty(true);
      setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
  }, [selectedNodeId, selectedEdgeId, nodes, setNodes, setEdges]);

  const updateNodeConfig = useCallback(
    (nodeId: string, config: Record<string, unknown>) => {
      setDirty(true);
      setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, config } } : n)));
    },
    [setNodes],
  );

  const updateEdgeBranch = useCallback(
    (edgeId: string, branch: string) => {
      setDirty(true);
      setEdges((eds) => eds.map((e) => (e.id === edgeId ? { ...e, data: { ...e.data, branch }, label: branch } : e)));
    },
    [setEdges],
  );

  const save = useMutation({
    mutationFn: async () => {
      const customGraph = flowToGraphEditable(nodes, edges);
      const res = await appFetch(`/api/app/workflow-configs/${encodeURIComponent(workflow.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, customGraph }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `Save failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["user-workflows"] });
    },
  });

  // Workflow Canvas v4 Phase 2 (2026-07-18) — plain-language -> draft graph.
  // Doesn't save anything itself; replaces the in-progress canvas (behind a
  // confirm if there are unsaved changes) so the merchant can review/edit
  // the draft like any other in-progress edit before hitting Save.
  const aiDraft = useMutation({
    mutationFn: async () => {
      const res = await appFetch(`/api/app/workflow-configs/${encodeURIComponent(workflow.id)}/ai-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `${res.status}`);
      }
      return (await res.json()) as { graph: WorkflowGraph };
    },
    onSuccess: (data) => {
      const { nodes: n, edges: e } = graphToFlowEditable(data.graph);
      setDirty(true);
      setNodes(n);
      setEdges(e);
      setAiPrompt("");
    },
  });

  const handleGenerate = useCallback(() => {
    if (!aiPrompt.trim()) return;
    if (dirty && !window.confirm("This will replace your current in-progress flow. Continue?")) return;
    aiDraft.mutate();
  }, [aiPrompt, dirty, aiDraft]);

  return (
    <div className="page-enter flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex items-center justify-between gap-3 pb-4 border-b border-border mb-0">
        <div className="flex items-center gap-3 min-w-0">
          <Breadcrumbs
            className="mb-0"
            items={[
              { label: "Workflows", href: appPath("/workflows") },
              { label: workflow.name },
            ]}
          />
          <Badge variant="secondary" className="text-[10px]">Custom</Badge>
        </div>
        <div className="flex items-center gap-2">
          {(selectedNodeId || selectedEdgeId) && (
            <Button variant="outline" size="sm" onClick={deleteSelected}>
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setPreviewOpen((v) => !v)}>
            <Play className="size-3.5" aria-hidden />
            Preview
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />}
            {!dirty && save.isSuccess ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

      {/* AI-assisted drafting (Workflow Canvas v4 Phase 2) */}
      <div className="flex items-center gap-2 py-3 border-b border-border">
        <Sparkles className="size-4 text-primary shrink-0" aria-hidden />
        <Input
          value={aiPrompt}
          onChange={(e) => setAiPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
          placeholder="Describe what you want this workflow to do — e.g. 'call abandoned carts over ₹2000, offer 10% off if no answer twice'"
          className="flex-1"
        />
        <Button size="sm" variant="outline" onClick={handleGenerate} disabled={aiDraft.isPending || !aiPrompt.trim()}>
          {aiDraft.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
          Generate
        </Button>
      </div>
      {aiDraft.isError && <p className="text-xs text-destructive py-1">{(aiDraft.error as Error).message}</p>}
      {save.isError && <p className="text-xs text-destructive py-1">{(save.error as Error).message}</p>}

      <div className="flex flex-1 overflow-hidden">
        <NodePalette onAddNode={addNodeFromPalette} excludeTypes={MERCHANT_LOCKED_EXCLUDED} />
        <div className="flex-1 relative" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setReactFlowInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            fitView
            className="bg-muted/30"
          >
            <Background gap={20} size={1} />
            <Controls />
            <MiniMap className="!bg-card !border-border" />
          </ReactFlow>
        </div>

        {(selectedNode || selectedEdge) && (
          <div className="w-72 border-l border-border overflow-y-auto p-4">
            {selectedNode && (
              <NodeConfigPanel
                nodeType={selectedNode.data.nodeType as WorkflowNodeType}
                config={selectedNode.data.config as Record<string, unknown>}
                onUpdate={(config) => updateNodeConfig(selectedNode.id, config)}
              />
            )}
            {selectedEdge && (
              <div className="space-y-3">
                <h3 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Edge branch
                </h3>
                <select
                  value={(selectedEdge.data?.branch as string) || ""}
                  onChange={(e) => updateEdgeBranch(selectedEdge.id, e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">(none)</option>
                  {WORKFLOW_OUTCOMES.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {previewOpen && (
          <FlowPreviewPanel
            templateKey={workflow.id}
            graph={flowToGraphEditable(nodes, edges)}
            onClose={() => setPreviewOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

export function UserWorkflowsListPage() {
  const queryClient = useQueryClient();
  const workflows = useQuery<{ workflows: WorkflowResponse[] }>({
    queryKey: ["user-workflows"],
    queryFn: async () => {
      const res = await appFetch("/api/app/workflow-configs");
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  // List-level enable/disable without opening the canvas. Passes the current
  // overrides back so the value-only save doesn't wipe them (the PUT resets
  // overrides to null when the field is omitted); customGraph is preserved
  // server-side when not included in the body.
  const toggle = useMutation({
    mutationFn: async (w: WorkflowResponse) => {
      const res = await appFetch(`/api/app/workflow-configs/${encodeURIComponent(w.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !w.orgConfig.enabled, overrides: w.orgConfig.overrides }),
      });
      if (!res.ok) throw new Error(`toggle failed (${res.status})`);
      return res.json();
    },
    onSuccess: (_data, w) => {
      queryClient.invalidateQueries({ queryKey: ["user-workflows"] });
      toast.success(w.orgConfig.enabled ? `${w.name} paused` : `${w.name} activated`);
    },
    onError: (err: Error) => toast.error("Couldn't update workflow", { description: err.message }),
  });

  const rows = workflows.data?.workflows ?? [];

  return (
    <div className="page-enter">
      <PageHeader
        title="Workflows"
        description="Call automation flows for your store. Toggle a workflow on or off here, or click it to customize timings and messages."
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
        {rows.map((w) => {
          const active = w.orgConfig.enabled;
          return (
            <div key={w.id} className="card-action p-5 h-full flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <Link href={appPath(`/workflows/${encodeURIComponent(w.id)}`)} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <GitBranch className="size-4 text-primary shrink-0" aria-hidden />
                    <span className="font-medium text-sm">{w.name}</span>
                    {w.orgConfig.customGraph && <Badge variant="secondary" className="text-[10px]">Custom</Badge>}
                  </div>
                  {w.description && (
                    <p className="mb-2 text-xs text-muted-foreground line-clamp-2">{w.description}</p>
                  )}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      active ? "bg-emerald-500/15 text-emerald-400" : "bg-zinc-500/15 text-zinc-400"
                    }`}>
                      <span className={`size-1.5 rounded-full ${active ? "bg-emerald-400" : "bg-zinc-500"}`} />
                      {active ? "Active" : "Paused"}
                    </span>
                    <Badge variant="secondary" className="text-[10px]">{w.vertical}</Badge>
                    {(() => {
                      const steps = countMerchantSteps(w.orgConfig.customGraph ?? w.graph);
                      return <span>{steps} {steps === 1 ? "step" : "steps"}</span>;
                    })()}
                  </div>
                </Link>
                <Switch
                  checked={active}
                  disabled={toggle.isPending}
                  onCheckedChange={() => toggle.mutate(w)}
                  aria-label={active ? `Pause ${w.name}` : `Activate ${w.name}`}
                />
              </div>
              {!active && (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Paused — this workflow won't place any automated calls until you turn it back on.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function UserWorkflowDetailPage() {
  const [, params] = useRoute<{ id: string }>(appPath("/workflows/:id"));
  const id = params?.id ? decodeURIComponent(params.id) : "";
  // Set once a merchant clicks "Customize from this template" or "Start
  // blank" from the standard view — switches this page into the full
  // canvas editor with that starting graph, unsaved until they hit Save.
  const [buildingFrom, setBuildingFrom] = useState<WorkflowGraph | null>(null);

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

  const alreadyCustom = workflow.orgConfig.customGraph;
  const startingGraph = buildingFrom ?? alreadyCustom ?? null;

  return (
    <ReactFlowProvider>
      {startingGraph ? (
        <UserWorkflowCanvasEditor workflow={workflow} startingGraph={startingGraph} />
      ) : (
        <UserWorkflowStandardView workflow={workflow} onStartCustomizing={setBuildingFrom} />
      )}
    </ReactFlowProvider>
  );
}
