import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Shield, Plus, ToggleLeft, ToggleRight, Trash2, Loader2, Save } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { Button } from "../../components/ui/button";

type FeatureFlag = {
  id: number;
  key: string;
  orgId: string;
  enabled: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export function FlagsPage() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [key, setKey] = useState("");
  const [orgId, setOrgId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [description, setDescription] = useState("");

  const flags = useQuery<{ flags: FeatureFlag[] }>({
    queryKey: ["admin-flags"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/flags", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load flags");
      return res.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/voice/flags", {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          orgId: orgId.trim() || "",
          enabled,
          description: description || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? `Failed to save flag (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setShowCreate(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["admin-flags"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: number; enabled: boolean }) => {
      const res = await apiFetch(`/api/voice/flags/${id}`, {
        method: "PUT",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`Toggle failed (${res.status})`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-flags"] }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiFetch(`/api/voice/flags/${id}`, {
        method: "DELETE",
        headers: adminHeaders(),
      });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-flags"] }),
  });

  function resetForm() {
    setKey("");
    setOrgId("");
    setEnabled(false);
    setDescription("");
    setError(null);
  }

  const rows = flags.data?.flags ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Shield className="size-5 text-primary" />
            Feature Flags
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-xl">
            Control environment variables, toggle compliance gates, or run org-specific rollouts.
          </p>
        </div>
        {!showCreate && (
          <Button
            onClick={() => {
              resetForm();
              setShowCreate(true);
            }}
            text-xs
          >
            <Plus className="size-4 mr-1.5" />
            Add Flag
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {showCreate && (
        <div className="card-weeber p-6 space-y-4 content-fade-in">
          <h2 className="text-base font-semibold">Create or Override Feature Flag</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Flag Key</label>
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="e.g. hipaa-mode"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm w-full outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Organization ID (optional)</label>
              <input
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                placeholder="Leave blank for Global scope"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm w-full outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Enables HIPAA strict logs scrubbing."
                className="rounded-md border border-border bg-background px-3 py-2 text-sm w-full outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="accent-primary"
                />
                Enabled by default
              </label>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? <Loader2 className="size-4 animate-spin mr-1.5" /> : <Save className="size-4 mr-1.5" />}
              Save Flag
            </Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {flags.isLoading && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Loading feature flags…
        </div>
      )}

      {!flags.isLoading && rows.length === 0 && !showCreate && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No feature flags set.
        </div>
      )}

      {rows.length > 0 && !showCreate && (
        <div className="card-weeber divide-y divide-border">
          {rows.map((flag) => (
            <div key={flag.id} className="flex justify-between items-center gap-4 p-4 hover:bg-muted/10 transition-colors">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <code className="font-mono bg-muted/60 px-1 rounded text-primary">{flag.key}</code>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {flag.orgId === "" ? "Global" : `Org: ${flag.orgId}`}
                  </span>
                </div>
                {flag.description && <p className="text-xs text-muted-foreground">{flag.description}</p>}
              </div>

              <div className="flex items-center gap-4 shrink-0">
                <button
                  onClick={() => toggle.mutate({ id: flag.id, enabled: !flag.enabled })}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Toggle flag"
                >
                  {flag.enabled ? (
                    <ToggleRight className="size-6 text-primary" />
                  ) : (
                    <ToggleLeft className="size-6" />
                  )}
                </button>

                <button
                  onClick={() => remove.mutate(flag.id)}
                  className="text-muted-foreground hover:text-destructive transition-colors p-1"
                  aria-label="Delete flag"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
