import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonTable } from "../../components/shell/skeletons";
import { DataTable, type Column } from "../../components/shell/data-table";
import { Badge } from "../../components/ui/badge";

type WaitlistRow = {
  id: number;
  email: string;
  name: string | null;
  referralCode: string | null;
  ownReferralCode: string | null;
  referralCount: number;
  phone: string | null;
  unsubscribed: boolean;
  source: string | null;
  convertedOrgId: string | null;
  createdAt: string;
};

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function WaitlistPage() {
  const waitlist = useQuery<{ signups: WaitlistRow[] }>({
    queryKey: ["admin-waitlist"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/waitlist", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load waitlist");
      return res.json();
    },
  });

  const rows = waitlist.data?.signups ?? [];
  const columns: Column<WaitlistRow>[] = [
    { key: "email", header: "Email", render: (r) => r.email },
    { key: "name", header: "Name", render: (r) => r.name ?? "\u2014" },
    { key: "source", header: "Source", render: (r) => r.source ?? "(direct)" },
    { key: "referredBy", header: "Referred by", render: (r) => r.referralCode ?? "\u2014" },
    { key: "ownCode", header: "Their code", render: (r) => r.ownReferralCode ?? "\u2014" },
    { key: "referrals", header: "Referrals", render: (r) => r.referralCount },
    { key: "phone", header: "Phone", render: (r) => r.phone ?? "\u2014" },
    {
      key: "status",
      header: "Status",
      render: (r) => {
        if (r.unsubscribed) return <Badge variant="destructive">Unsubscribed</Badge>;
        if (r.convertedOrgId) return <Badge variant="default">Converted</Badge>;
        return <Badge variant="outline">Waiting</Badge>;
      },
    },
    { key: "joined", header: "Joined", render: (r) => formatWhen(r.createdAt) },
  ];

  return (
    <div>
      <PageHeader title="Waitlist" description="Pre-launch signups from the landing page." />
      {waitlist.isLoading && <SkeletonTable columns={6} />}
      {!waitlist.isLoading && rows.length === 0 && (
        <EmptyState title="No signups yet" description="Entries appear here as soon as someone joins the waitlist from the landing page." />
      )}
      {rows.length > 0 && <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />}
    </div>
  );
}
