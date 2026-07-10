import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Store, User, Bot, ArrowLeftRight, Users, ChevronDown, ChevronUp } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { setImpersonationToken } from "../../lib/merchant-session";

type OrgOverviewRow = {
  id: string;
  name: string | null;
  vertical: string;
  planName: string | null;
  currency: string | null;
  countryCode: string | null;
  timezone: string | null;
  contactEmail: string | null;
  createdAt: string;
  connectedShops: number;
  members: number;
  enabledAgents: number;
};

type OrgDetail = {
  org: any;
  shops: any[];
  members: any[];
  configs: any[];
  activeImpersonations: any[];
};

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function OrgsPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const orgs = useQuery<{ orgs: OrgOverviewRow[] }>({
    queryKey: ["admin-orgs-overview"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/orgs/overview", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load orgs");
      return res.json();
    },
  });

  const detail = useQuery<OrgDetail>({
    queryKey: ["admin-org-detail", expandedId],
    enabled: Boolean(expandedId),
    queryFn: async () => {
      const res = await apiFetch(`/api/voice/orgs/${encodeURIComponent(expandedId!)}`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load org details");
      return res.json();
    },
  });

  const impersonate = useMutation({
    mutationFn: async (orgId: string) => {
      const res = await apiFetch("/api/voice/impersonation/start", {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ orgId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? `Failed to impersonate (${res.status})`);
      }
      return res.json() as Promise<{ impersonation: { token: string; id: number } }>;
    },
    onSuccess: (data) => {
      setImpersonationToken(data.impersonation.token, data.impersonation.id);
      // Open /app in a new window/tab
      window.open("/app", "_blank");
    },
  });

  const rows = orgs.data?.orgs ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="size-5 text-primary" />
          Organizations
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          Overview of all merchant workspaces, seats, agents, and store connection status.
        </p>
      </div>

      {orgs.isLoading && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Loading organizations…
        </div>
      )}

      {orgs.isError && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load organizations.
        </div>
      )}

      {rows.length > 0 && (
        <div className="rounded-lg border border-border divide-y divide-border bg-card">
          {rows.map((org) => {
            const isExpanded = expandedId === org.id;
            return (
              <div key={org.id} className="transition-colors hover:bg-muted/10">
                <div
                  onClick={() => setExpandedId(isExpanded ? null : org.id)}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-4 cursor-pointer"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>{org.name || org.id}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                        {org.vertical}
                      </span>
                      {org.planName && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary font-medium">
                          {org.planName}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      ID: <span className="font-mono">{org.id}</span> · Joined {formatWhen(org.createdAt)}
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    <div className="flex gap-4 text-xs text-muted-foreground shrink-0">
                      <span className="flex items-center gap-1">
                        <Store className="size-3.5" />
                        {org.connectedShops} shops
                      </span>
                      <span className="flex items-center gap-1">
                        <User className="size-3.5" />
                        {org.members} members
                      </span>
                      <span className="flex items-center gap-1">
                        <Bot className="size-3.5" />
                        {org.enabledAgents} agents
                      </span>
                    </div>

                    <div>
                      {isExpanded ? (
                        <ChevronUp className="size-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="size-4 text-muted-foreground" />
                      )}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-border bg-muted/30 px-6 py-4 space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-sm font-semibold">Workspace Details</h3>
                      <button
                        onClick={() => impersonate.mutate(org.id)}
                        disabled={impersonate.isPending}
                        className="inline-flex items-center gap-1.5 rounded bg-warning text-warning-foreground px-3 py-1.5 text-xs font-medium hover:bg-warning/90 transition-colors disabled:opacity-50"
                      >
                        <ArrowLeftRight className="size-3.5" />
                        Impersonate Workspace
                      </button>
                    </div>

                    {detail.isLoading && <p className="text-xs text-muted-foreground">Loading workspace detail…</p>}

                    {detail.data && (
                      <div className="grid gap-6 sm:grid-cols-2 text-xs">
                        <div className="space-y-2">
                          <h4 className="font-medium text-muted-foreground">Connected Stores</h4>
                          {detail.data.shops.length === 0 ? (
                            <p className="text-muted-foreground">No store connected.</p>
                          ) : (
                            <div className="space-y-1">
                              {detail.data.shops.map((s) => (
                                <div key={s.shop} className="flex justify-between border-b border-border pb-1">
                                  <span className="font-mono">{s.shop}</span>
                                  <span className={s.disconnectedAt ? "text-destructive" : "text-success"}>
                                    {s.disconnectedAt ? "Disconnected" : "Connected"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="space-y-2">
                          <h4 className="font-medium text-muted-foreground">Agent Configs</h4>
                          {detail.data.configs.length === 0 ? (
                            <p className="text-muted-foreground">No custom agent configurations.</p>
                          ) : (
                            <div className="space-y-1">
                              {detail.data.configs.map((c) => (
                                <div key={c.templateKey} className="flex justify-between border-b border-border pb-1">
                                  <span>{c.templateKey}</span>
                                  <span className={c.enabled ? "text-success font-medium" : "text-muted-foreground"}>
                                    {c.enabled ? "Active" : "Disabled"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
