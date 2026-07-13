import { useState, useCallback, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, Save, Loader as Loader2, Download, Trash2 } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { Button } from "../../components/ui/button";
import { SkeletonCards } from "../../components/shell/skeletons";
import { WorkflowNode } from "../../components/canvas/WorkflowNode";
import { BranchEdge } from "../../components/canvas/BranchEdge";
import { NodePalette } from "../../components/canvas/NodePalette";
import { CART_RECOVERY_GRAPH } from "../../components/canvas/seed-graph";
import { NodeConfigPanel } from "../../components/canvas/NodeConfigPanel";
import { WORKFLOW_OUTCOMES } from "../../components/canvas/types";
import type { WorkflowNodeType, WorkflowGraph } from "../../components/canvas/types";

type TemplateResponse = {
  id: string;
  name: string;
  vertical: string;
  graph: WorkflowGraph;
  active: boolean;
};

const nodeTypes = { workflow: WorkflowNode };
const edgeTypes = { branch: BranchEdge };

function graphToFlow(graph: WorkflowGraph) {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "workflow",
    position: n.position,
    data: { nodeType: n.type, config: n.config, label: n.id },
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

function flowToGraph(nodes: Node[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.nodeType as WorkflowNodeType,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      config: n.data.config as Record<string, unknown>,
    })) as WorkflowGraph["nodes"],
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.data?.branch ? { branch: e.data.branch as string } : {}),
    })),
  };
}

let nodeCounter = 0;

function EditorInner({ template }: { template: TemplateResponse }) {
  const qc = useQueryClient();
  const initial = useMemo(() => graphToFlow(template.graph), [template.graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);

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
      setEdges((eds) => addEdge(edge, eds));
    },
    [nodes, setEdges],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("application/workflow-node-type") as WorkflowNodeType;
      if (!type || !reactFlowInstance) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      const defaultConfigs: Record<WorkflowNodeType, unknown> = {
        trigger: { event: "checkout_abandoned" },
        wait: { delayMinutes: 60 },
        call: { persona: "", discountPercent: 0 },
        conditionalSplit: { outcomes: ["no-answer", "interested", "not-interested"] },
        sms: { template: "" },
        addToDnc: { reason: "" },
        webhook: { url: "" },
      };

      nodeCounter++;
      const newNode: Node = {
        id: `${type}-${Date.now()}-${nodeCounter}`,
        type: "workflow",
        position,
        data: { nodeType: type, config: defaultConfigs[type], label: type },
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [reactFlowInstance, setNodes],
  );

  const save = useMutation({
    mutationFn: async () => {
      const graph = flowToGraph(nodes, edges);
      const res = await apiFetch(`/api/workflows/workflow-templates/${encodeURIComponent(template.id)}`, {
        method: "PUT",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ graph }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string; details?: string[] }).details?.join(", ") || (err as { error?: string }).error || `${res.status}`);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow-template", template.id] }),
  });

  const loadExample = useCallback(() => {
    const { nodes: n, edges: e } = graphToFlow(CART_RECOVERY_GRAPH);
    setNodes(n);
    setEdges(e);
  }, [setNodes, setEdges]);

  const deleteSelected = useCallback(() => {
    if (selectedNodeId) {
      setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
      setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
      setSelectedNodeId(null);
    }
    if (selectedEdgeId) {
      setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
  }, [selectedNodeId, selectedEdgeId, setNodes, setEdges]);

  const updateNodeConfig = useCallback(
    (nodeId: string, config: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, config } } : n,
        ),
      );
    },
    [setNodes],
  );

  const updateEdgeBranch = useCallback(
    (edgeId: string, branch: string) => {
      setEdges((eds) =>
        eds.map((e) =>
          e.id === edgeId ? { ...e, data: { ...e.data, branch }, label: branch } : e,
        ),
      );
    },
    [setEdges],
  );

  return (
    <div className="page-enter flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex items-center justify-between gap-3 pb-4 border-b border-border mb-0">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/dashboard/workflows"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Workflows
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <h1 className="font-medium text-sm truncate">{template.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadExample}>
            <Download className="size-3.5" aria-hidden />
            Load example
          </Button>
          {(selectedNodeId || selectedEdgeId) && (
            <Button variant="outline" size="sm" onClick={deleteSelected}>
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </Button>
          )}
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />}
            {save.isSuccess ? "Saved" : "Save"}
          </Button>
        </div>
      </div>
      {save.isError && (
        <p className="text-xs text-destructive py-2">{(save.error as Error).message}</p>
      )}

      <div className="flex flex-1 overflow-hidden">
        <NodePalette />
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
                nodeId={selectedNode.id}
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
      </div>
    </div>
  );
}

export function WorkflowEditorPage() {
  const [, params] = useRoute<{ id: string }>("/dashboard/workflows/:id");
  const id = params?.id ? decodeURIComponent(params.id) : "";

  const template = useQuery<TemplateResponse>({
    queryKey: ["workflow-template", id],
    enabled: !!id,
    queryFn: async () => {
      const res = await apiFetch(`/api/workflows/workflow-templates/${encodeURIComponent(id)}`, {
        headers: adminHeaders(),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  if (template.isLoading) return <SkeletonCards count={1} lines={6} />;
  if (!template.data) return <p className="text-sm text-muted-foreground">Template not found.</p>;

  return (
    <ReactFlowProvider>
      <EditorInner template={template.data} />
    </ReactFlowProvider>
  );
}
