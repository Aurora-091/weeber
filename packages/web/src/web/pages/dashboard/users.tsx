import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { UserCheck, ArrowLeftRight } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { setImpersonationToken } from "../../lib/merchant-session";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonTable } from "../../components/shell/skeletons";
import { DataTable, type Column } from "../../components/shell/data-table";
import { Badge } from "../../components/ui/badge";

type UserRow = {
  id: number;
  supabaseUserId: string;
  email: string | null;
  role: string;
  createdAt: string;
  orgId: string;
  orgName: string | null;
  orgVertical: string;
};

type ImpersonationAudit = {
  id: number;
  orgId: string;
  adminActor: string;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
};

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "\u2014";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Person-centric admin view (org_members + org context) — distinct from the
 * Orgs page, matching Vocalist's real admin nav split between Users and
 * org-level views. The "Log in as" action + the impersonation audit trail
 * both live here now instead of a standalone Impersonate nav item (Vocalist
 * doesn't have one either) — the capability and its audit log are
 * unchanged, only the entry point moved.
 */
export function UsersPage() {
  const queryClient = useQueryClient();

  const users = useQuery<{ users: UserRow[] }>({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/users", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load users");
      return res.json();
    },
  });

  const audit = useQuery<{ audit: ImpersonationAudit[]; active: ImpersonationAudit[] }>({
    queryKey: ["admin-impersonation-audit"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/impersonation/audit", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load audit log");
      return res.json();
    },
    refetchInterval: 15000,
  });

  const impersonate = useMutation({
    mutationFn: async (orgId: string) => {
      const res = await apiFetch("/api/voice/impersonation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ orgId }),
      });
      if (!res.ok) throw new Error("Failed to start impersonation");
      return res.json();
    },
    onSuccess: (data) => {
      setImpersonationToken(data.impersonation.token, data.impersonation.id);
      queryClient.invalidateQueries({ queryKey: ["admin-impersonation-audit"] });
      window.open("/app", "_blank");
    },
  });

  const stop = useMutation({
    mutationFn: async (id: number) => {
      await apiFetch(`/api/voice/impersonation/${id}/stop`, { method: "POST", headers: adminHeaders() });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-impersonation-audit"] }),
  });

  const rows = users.data?.users ?? [];
  const columns: Column<UserRow>[] = [
    { key: "email", header: "Email", render: (r) => r.email ?? <span className="text-muted-foreground">(no email on file yet)</span> },
    { key: "org", header: "Org", render: (r) => `${r.orgName ?? r.orgId} (${r.orgVertical})` },
    { key: "role", header: "Role", render: (r) => <Badge variant="outline">{r.role}</Badge> },
    { key: "joined", header: "Joined", render: (r) => formatWhen(r.createdAt) },
    {
      key: "actions",
      header: "",
      className: "text-right",
      render: (r) => (
        <button
          onClick={() => impersonate.mutate(r.orgId)}
          disabled={impersonate.isPending}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <ArrowLeftRight className="size-3.5" />
          Log in as
        </button>
      ),
    },
  ];

  const active = audit.data?.active ?? [];
  const history = audit.data?.audit ?? [];

  return (
    <div>
      <PageHeader title="Users" description="Individual accounts across every org." />

      {users.isLoading && <SkeletonTable columns={5} />}
      {!users.isLoading && rows.length === 0 && (
        <EmptyState title="No users yet" description="Accounts appear here once a merchant signs up and completes onboarding." />
      )}
      {rows.length > 0 && <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />}

      {active.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium mb-3 flex items-center gap-1.5">
            <UserCheck className="size-3.5" />
            Active impersonation sessions
          </h2>
          <div className="rounded-lg border border-border divide-y divide-border">
            {active.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-4 py-3">
                <div className="text-sm">
                  <span className="font-mono text-xs">{s.orgId}</span> — started by {s.adminActor} at {formatWhen(s.startedAt)}
                </div>
                <button onClick={() => stop.mutate(s.id)} className="text-xs text-destructive hover:underline">
                  Stop
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium mb-3">Impersonation audit trail</h2>
          <DataTable
            columns={[
              { key: "org", header: "Org", render: (r: ImpersonationAudit) => <span className="font-mono text-xs">{r.orgId}</span> },
              { key: "actor", header: "Admin", render: (r: ImpersonationAudit) => r.adminActor },
              { key: "started", header: "Started", render: (r: ImpersonationAudit) => formatWhen(r.startedAt) },
              { key: "ended", header: "Ended", render: (r: ImpersonationAudit) => (r.endedAt ? `${formatWhen(r.endedAt)} (${r.endedReason})` : "still active") },
            ]}
            rows={history}
            rowKey={(r) => r.id}
          />
        </div>
      )}
    </div>
  );
}
