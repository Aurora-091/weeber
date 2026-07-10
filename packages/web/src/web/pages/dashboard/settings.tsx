import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2, Plus, Copy, Check } from "lucide-react";
import { api } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [justCreated, setJustCreated] = useState<{ label: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keys = useQuery({
    queryKey: ["admin-keys"],
    queryFn: async () => {
      const res = await api.voice["admin-keys"].$get({}, { headers: adminHeaders() });
      return res.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await api.voice["admin-keys"].$post({ json: { label } }, { headers: adminHeaders() });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      if ("adminKey" in data) {
        setJustCreated({ label: data.adminKey.label, key: data.adminKey.key });
      }
      setLabel("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["admin-keys"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const revoke = useMutation({
    mutationFn: async (id: number) => {
      await api.voice["admin-keys"][":id"].$delete({ param: { id: String(id) } }, { headers: adminHeaders() });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-keys"] }),
  });

  const rows = keys.data && "adminKeys" in keys.data ? keys.data.adminKeys : [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <KeyRound className="size-5 text-primary" />
          Admin keys
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          Your original <code className="font-mono text-xs">ADMIN_API_KEY</code> env var always keeps working —
          this is an additional way to hand out labeled, individually revocable keys instead of sharing that one
          secret with everyone.
        </p>
      </div>

      {justCreated && (
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 mb-8">
          <p className="text-sm font-medium mb-2">
            New key for "{justCreated.label}" — copy it now, it won't be shown again:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-card border border-border rounded px-3 py-2 overflow-x-auto">
              {justCreated.key}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(justCreated.key);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline shrink-0"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="flex flex-col sm:flex-row gap-2 mb-8"
      >
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label — e.g. Jane's laptop, n8n webhook"
          aria-label="Key label"
          className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
        />
        <button
          type="submit"
          disabled={!label.trim() || create.isPending}
          className="inline-flex items-center gap-1.5 justify-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          <Plus className="size-4" />
          Generate key
        </button>
      </form>
      {error && <p className="text-sm text-destructive -mt-6 mb-6">{error}</p>}

      <div className="rounded-lg border border-border divide-y divide-border">
        {rows.map((k) => (
          <div key={k.id} className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="text-sm font-medium">
                {k.label}
                {k.revokedAt && (
                  <span className="ml-2 text-[10px] font-mono uppercase tracking-wider text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
                    revoked
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                created {formatWhen(k.createdAt)} · last used {formatWhen(k.lastUsedAt)}
              </div>
            </div>
            {!k.revokedAt && (
              <button
                onClick={() => revoke.mutate(k.id)}
                className="text-muted-foreground hover:text-destructive transition-colors p-1.5"
                aria-label="Revoke key"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-4 py-8 text-sm text-muted-foreground text-center">
            No labeled keys yet — just the ADMIN_API_KEY env var.
          </div>
        )}
      </div>
    </div>
  );
}
