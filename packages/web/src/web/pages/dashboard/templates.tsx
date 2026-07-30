import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus, Loader2, Save } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { Button } from "../../components/ui/button";

type AgentTemplate = {
  id: number;
  key: string;
  name: string;
  vertical: string;
  description: string | null;
  defaultPersonaPrompt: string | null;
  defaultTools: string[];
  active: boolean;
  createdAt: string;
};

const AVAILABLE_TOOLS = [
  "lookupInfo",
  "bookAppointment",
  "setDisposition",
  "crmSync",
  "captureField",
  "hangUp",
  "transferToHuman",
  "flagGuardrailEvent",
];

export function TemplatesPage() {
  const queryClient = useQueryClient();
  const [editingTemplate, setEditingTemplate] = useState<AgentTemplate | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states for Create/Edit
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [vertical, setVertical] = useState("shopify");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [active, setActive] = useState(true);

  const templates = useQuery<{ agentTemplates: AgentTemplate[] }>({
    queryKey: ["admin-templates"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/agent-templates", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load templates");
      return res.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/voice/agent-templates", {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          name,
          vertical,
          description: description || null,
          defaultPersonaPrompt: prompt || null,
          defaultTools: tools,
          active,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? `Failed to create template (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setShowCreate(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["admin-templates"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const update = useMutation({
    mutationFn: async (tmplKey: string) => {
      const res = await apiFetch(`/api/voice/agent-templates/${encodeURIComponent(tmplKey)}`, {
        method: "PUT",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          defaultPersonaPrompt: prompt || null,
          defaultTools: tools,
          active,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? `Failed to update template (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setEditingTemplate(null);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["admin-templates"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  function resetForm() {
    setKey("");
    setName("");
    setVertical("shopify");
    setDescription("");
    setPrompt("");
    setTools([]);
    setActive(true);
    setError(null);
  }

  function startEdit(t: AgentTemplate) {
    setEditingTemplate(t);
    setShowCreate(false);
    setKey(t.key);
    setName(t.name);
    setVertical(t.vertical);
    setDescription(t.description ?? "");
    setPrompt(t.defaultPersonaPrompt ?? "");
    setTools(t.defaultTools ?? []);
    setActive(t.active);
    setError(null);
  }

  function toggleTool(tool: string) {
    setTools((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]));
  }

  const rows = templates.data?.agentTemplates ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Bot className="size-5 text-primary" />
            Agent Templates
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-xl">
            Manage the standard templates that drive each organization's agent configurations.
          </p>
        </div>
        {!editingTemplate && !showCreate && (
          <Button
            onClick={() => {
              resetForm();
              setShowCreate(true);
            }}
            text-xs
          >
            <Plus className="size-4 mr-1.5" />
            Create Template
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {(showCreate || editingTemplate) && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 content-fade-in">
          <h2 className="text-base font-semibold">{showCreate ? "Create New Agent Template" : `Edit Template: ${key}`}</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            {showCreate && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Template Key (unique)</label>
                <input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="e.g. shopify-cart-recovery"
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm w-full outline-none focus:ring-2 focus:ring-ring/40"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Display Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Cart Recovery Agent"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm w-full outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>

            {showCreate && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Vertical</label>
                <input
                  value={vertical}
                  onChange={(e) => setVertical(e.target.value)}
                  placeholder="e.g. shopify"
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm w-full outline-none focus:ring-2 focus:ring-ring/40"
                />
              </div>
            )}

            <div className={showCreate ? "sm:col-span-2" : ""}>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of the agent template trigger and target vertical context."
                rows={2}
                className="rounded-md border border-border bg-background px-3 py-2 text-sm w-full outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">Default Persona Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="The core LLM instructions template. Composed hierarchical at runtime."
                rows={8}
                className="rounded-md border border-border bg-background px-3 py-2 text-sm w-full outline-none focus:ring-2 focus:ring-ring/40 font-mono"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-2">Default Enabled Tools</label>
              <div className="flex flex-wrap gap-2">
                {AVAILABLE_TOOLS.map((tool) => {
                  const isChecked = tools.includes(tool);
                  return (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => toggleTool(tool)}
                      className={`rounded-md border px-3 py-1.5 text-xs font-mono transition-colors ${
                        isChecked
                          ? "border-primary bg-primary/10 text-primary font-medium"
                          : "border-border bg-background text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      {tool}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="sm:col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  className="accent-primary"
                />
                Template Active (Available for Orgs)
              </label>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              onClick={() => {
                if (showCreate) create.mutate();
                else update.mutate(editingTemplate!.key);
              }}
              disabled={create.isPending || update.isPending}
            >
              {create.isPending || update.isPending ? <Loader2 className="size-4 animate-spin mr-1.5" /> : <Save className="size-4 mr-1.5" />}
              Save Template
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setEditingTemplate(null);
                setShowCreate(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {templates.isLoading && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Loading templates…
        </div>
      )}

      {!templates.isLoading && rows.length === 0 && !showCreate && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No templates configured.
        </div>
      )}

      {rows.length > 0 && !showCreate && !editingTemplate && (
        <div className="rounded-lg border border-border divide-y divide-border bg-card">
          {rows.map((t) => (
            <div key={t.id} className="flex justify-between items-start gap-4 p-4 hover:bg-muted/10 transition-colors">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span>{t.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    {t.vertical}
                  </span>
                  {!t.active && (
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive font-medium uppercase tracking-wider">
                      inactive
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  Key: <code className="font-mono bg-muted/50 px-1 rounded">{t.key}</code>
                </div>
                {t.description && <p className="text-xs text-muted-foreground max-w-xl">{t.description}</p>}
                <div className="flex flex-wrap gap-1 mt-2">
                  {t.defaultTools.map((tool) => (
                    <span key={tool} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                      {tool}
                    </span>
                  ))}
                </div>
              </div>

              <Button variant="outline" className="text-xs" onClick={() => startEdit(t)}>
                Edit
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
