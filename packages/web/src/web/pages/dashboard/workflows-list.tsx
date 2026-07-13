import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, GitBranch, Loader as Loader2 } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../components/ui/dialog";

type WorkflowTemplate = {
  id: string;
  vertical: string;
  name: string;
  graph: { nodes: unknown[]; edges: unknown[] };
  active: boolean;
  createdAt: string;
};

export function WorkflowsListPage() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [newVertical, setNewVertical] = useState("shopify");

  const templates = useQuery<WorkflowTemplate[]>({
    queryKey: ["workflow-templates"],
    queryFn: async () => {
      const res = await apiFetch("/api/workflows/workflow-templates", {
        headers: adminHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/workflows/workflow-templates", {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          id: newId,
          name: newName,
          vertical: newVertical,
          graph: {
            nodes: [
              {
                id: "trigger-1",
                type: "trigger",
                position: { x: 400, y: 50 },
                config: { event: "checkout_abandoned" },
              },
            ],
            edges: [],
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflow-templates"] });
      setCreateOpen(false);
      setNewId("");
      setNewName("");
    },
  });

  const rows = templates.data ?? [];

  return (
    <div className="page-enter">
      <PageHeader
        title="Workflows"
        description="Graph-based call automation flows. Each workflow maps trigger events to a sequence of calls, waits, and actions."
        actions={
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="size-4" aria-hidden />
            New workflow
          </Button>
        }
      />

      {templates.isLoading && <SkeletonCards count={3} lines={2} />}

      {!templates.isLoading && rows.length === 0 && (
        <EmptyState
          title="No workflow templates"
          description="Create your first workflow template to start automating call flows."
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((t) => (
          <Link key={t.id} href={`/dashboard/workflows/${encodeURIComponent(t.id)}`}>
            <div className="card-action p-5 h-full">
              <div className="flex items-center gap-2 mb-2">
                <GitBranch className="size-4 text-primary" aria-hidden />
                <span className="font-medium text-sm truncate">{t.name}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary" className="text-[10px]">
                  {t.vertical}
                </Badge>
                <span>{t.graph.nodes.length} nodes</span>
                <span>{t.graph.edges.length} edges</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                {t.active ? (
                  <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-200">Active</Badge>
                ) : (
                  <Badge variant="secondary">Inactive</Badge>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create workflow template</DialogTitle>
            <DialogDescription>
              A new template starts with a single trigger node. Open the canvas to build the full graph.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="wf-id">Template ID</Label>
              <Input
                id="wf-id"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="shopify-cart-recovery-v1"
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="wf-name">Name</Label>
              <Input
                id="wf-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Cart Recovery"
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="wf-vertical">Vertical</Label>
              <select
                id="wf-vertical"
                value={newVertical}
                onChange={(e) => setNewVertical(e.target.value)}
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="shopify">Shopify</option>
                <option value="insurance">Insurance</option>
                <option value="clinic">Clinic</option>
              </select>
            </div>
            {create.isError && (
              <p className="text-xs text-destructive">{(create.error as Error).message}</p>
            )}
            <Button type="submit" disabled={create.isPending} className="w-full">
              {create.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Create template
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
