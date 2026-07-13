import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
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

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "\u2014";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Person-centric admin view (org_members + org context) — distinct from the
 * Orgs page, matching Vocalist's real admin nav split between Users and
 * org-level views.
 */
export function UsersPage() {
  const users = useQuery<{ users: UserRow[] }>({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/users", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load users");
      return res.json();
    },
  });

  const rows = users.data?.users ?? [];
  const columns: Column<UserRow>[] = [
    { key: "email", header: "Email", render: (r) => r.email ?? <span className="text-muted-foreground">(no email on file yet)</span> },
    { key: "org", header: "Org", render: (r) => `${r.orgName ?? r.orgId} (${r.orgVertical})` },
    { key: "role", header: "Role", render: (r) => <Badge variant="outline">{r.role}</Badge> },
    { key: "joined", header: "Joined", render: (r) => formatWhen(r.createdAt) },
  ];

  return (
    <div>
      <PageHeader title="Users" description="Individual accounts across every org." />

      {users.isLoading && <SkeletonTable columns={4} />}
      {!users.isLoading && rows.length === 0 && (
        <EmptyState title="No users yet" description="Accounts appear here once a user signs up and completes onboarding." />
      )}
      {rows.length > 0 && <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />}
    </div>
  );
}
