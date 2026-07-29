import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Phone, Trash2, Loader as Loader2, Search, RefreshCw, AlertCircle } from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";
import { formatDate } from "../../lib/format";

type OrgPhoneNumber = {
  id: number;
  orgId: string;
  provider: "twilio" | "plivo" | "exotel";
  phoneNumber: string;
  status: "active" | "released";
  numberSeries: "140" | "160" | "1600" | null;
  purchasedAt: string;
};

type AvailableNumber = { phoneNumber: string; locality: string | null; region: string | null };

// C2b — the numbers picker. An org can now hold several Twilio numbers (one
// per agent, via the dropdown on the Agents page) instead of a single
// shared outboundNumber. Search -> pick from real candidates -> buy;
// release when a number is no longer needed. Deliberately Twilio-only for
// now (Plivo/Exotel platform-buy is a fast-follow — those two stay BYO).
export function UserNumbersPage() {
  const queryClient = useQueryClient();
  const [countryCode, setCountryCode] = useState("US");
  const [areaCode, setAreaCode] = useState("");
  const [searched, setSearched] = useState(false);

  const numbers = useQuery({
    queryKey: ["app-numbers"],
    queryFn: async () => {
      const res = await appFetch("/api/app/numbers");
      if (!res.ok) throw new Error(`numbers failed (${res.status})`);
      return (await res.json()) as { numbers: OrgPhoneNumber[] };
    },
  });

  const available = useQuery({
    queryKey: ["app-numbers-available", countryCode, areaCode],
    queryFn: async () => {
      const params = new URLSearchParams({ countryCode });
      if (areaCode.trim()) params.set("areaCode", areaCode.trim());
      const res = await appFetch(`/api/app/numbers/available?${params.toString()}`);
      const data = await res.json().catch(() => ({ error: "Search failed" }));
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      return data as { numbers: AvailableNumber[] };
    },
    enabled: false,
  });

  const buy = useMutation({
    mutationFn: async (phoneNumber: string) => {
      const res = await appFetch("/api/app/numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber }),
      });
      const data = await res.json().catch(() => ({ error: "Purchase failed" }));
      if (!res.ok) throw new Error(data.error ?? "Purchase failed");
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Purchased ${data.phoneNumber}`);
      setSearched(false);
      queryClient.invalidateQueries({ queryKey: ["app-numbers"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const release = useMutation({
    mutationFn: async (id: number) => {
      const res = await appFetch(`/api/app/numbers/${id}/release`, { method: "POST" });
      const data = await res.json().catch(() => ({ error: "Release failed" }));
      if (!res.ok) throw new Error(data.error ?? "Release failed");
      return data;
    },
    onSuccess: () => {
      toast.success("Number released");
      queryClient.invalidateQueries({ queryKey: ["app-numbers"] });
    },
    onError: (err) => toast.error(err.message),
  });

  // Insurance vertical India/US iteration (2026-07-16,
  // docs/agent-prompts/00-insurance-regulatory-reference.md, "Platform gaps" #1) — lets any org
  // record which TRAI number series a number is registered under. Only actually enforced for
  // insurance-vertical orgs (see checkInsuranceNumberSeriesCompliance), but any org can set it.
  const setSeries = useMutation({
    mutationFn: async ({ id, numberSeries }: { id: number; numberSeries: string | null }) => {
      const res = await appFetch(`/api/app/numbers/${id}/series`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numberSeries }),
      });
      const data = await res.json().catch(() => ({ error: "Failed to update series" }));
      if (!res.ok) throw new Error(data.error ?? "Failed to update series");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-numbers"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const rows = numbers.data?.numbers ?? [];
  const activeRows = rows.filter((r) => r.status === "active");

  function handleSearch() {
    setSearched(true);
    void available.refetch();
  }

  return (
    <div className="page-enter">
      <PageHeader
        title="Phone Numbers"
        description="Buy dedicated numbers for your agents to call from. Assign a number to a specific agent on its Agents page, or leave it as your org's shared default."
      />

      <div className="card-weeber p-6 mb-6">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Country</Label>
            <select
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40 h-9"
            >
              <option value="US">United States</option>
              <option value="IN">India</option>
              <option value="GB">United Kingdom</option>
              <option value="CA">Canada</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Area code (optional)</Label>
            <Input value={areaCode} onChange={(e) => setAreaCode(e.target.value)} placeholder="e.g. 415" className="w-32" />
          </div>
          <Button onClick={handleSearch} disabled={available.isFetching}>
            {available.isFetching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            Search available numbers
          </Button>
        </div>

        {searched && (
          <div className="mt-5">
            {available.isFetching && <SkeletonCards count={3} />}
            {available.isError && (
              <p className="text-sm text-destructive">{(available.error as Error).message}</p>
            )}
            {available.data && available.data.numbers.length === 0 && (
              <p className="text-sm text-muted-foreground">No available numbers found — try a different area code or country.</p>
            )}
            {available.data && available.data.numbers.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {available.data.numbers.map((n) => (
                  <div key={n.phoneNumber} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <div>
                      <div className="text-sm font-medium">{n.phoneNumber}</div>
                      <div className="text-xs text-muted-foreground">{[n.locality, n.region].filter(Boolean).join(", ") || "—"}</div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => buy.mutate(n.phoneNumber)} disabled={buy.isPending}>
                      Buy
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card-weeber p-6">
        <h3 className="text-sm font-semibold mb-3">Your numbers</h3>
        {numbers.isLoading && <SkeletonCards count={2} />}
        {numbers.isError && (
          <EmptyState
            title="Couldn't load your numbers"
            description="Something went wrong. Check your connection and try again."
            icon={AlertCircle}
            action={
              <Button size="sm" variant="outline" onClick={() => numbers.refetch()}>
                <RefreshCw className="size-3.5" aria-hidden />
                Retry
              </Button>
            }
          />
        )}
        {!numbers.isLoading && !numbers.isError && activeRows.length === 0 && (
          <EmptyState
            icon={Phone}
            title="No numbers yet"
            description="Buy a number above to give an agent its own dedicated caller ID."
          />
        )}
        {activeRows.length > 0 && (
          <div className="divide-y divide-border content-fade-in">
            {activeRows.map((row) => (
              <div key={row.id} className="flex items-center justify-between py-3">
                <div>
                  <div className="text-sm font-medium">{row.phoneNumber}</div>
                  <div className="text-xs text-muted-foreground capitalize">
                    {row.provider} · purchased {formatDate(row.purchasedAt)}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    Series
                    <select
                      className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
                      value={row.numberSeries ?? ""}
                      onChange={(e) => setSeries.mutate({ id: row.id, numberSeries: e.target.value || null })}
                      disabled={setSeries.isPending}
                      aria-label={`TRAI number series for ${row.phoneNumber}`}
                    >
                      <option value="">— unset —</option>
                      <option value="140">140 (promotional)</option>
                      <option value="160">160 (transactional)</option>
                      <option value="1600">1600 (BFSI/insurance)</option>
                    </select>
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Release ${row.phoneNumber}? Any agent assigned to it will need a new number.`)) {
                        release.mutate(row.id);
                      }
                    }}
                    disabled={release.isPending}
                  >
                    <Trash2 className="size-4" />
                    Release
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
