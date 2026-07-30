import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Store, User, Bot, Users, ChevronDown, ChevronUp, Phone, Loader2 } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { formatDate } from "../../lib/format";

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
};

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "never";
  return formatDate(iso);
}

type TwilioStatus = {
  mode: "platform" | "byo";
  accountSid: string | null;
  outboundNumber: string | null;
  usingGlobalDefault: boolean;
};

/** Masks a Twilio Account SID down to its prefix + last 4 — never show the
 * full SID (or, obviously, the auth token, which the API never returns at all). */
function maskSid(sid: string | null): string {
  if (!sid) return "\u2014";
  if (sid.length <= 8) return sid;
  return `${sid.slice(0, 6)}\u2026${sid.slice(-4)}`;
}

function TwilioSection({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const [showByoForm, setShowByoForm] = useState(false);
  const [byoSid, setByoSid] = useState("");
  const [byoToken, setByoToken] = useState("");
  const [byoNumber, setByoNumber] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [areaCode, setAreaCode] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const status = useQuery<{ twilio: TwilioStatus }>({
    queryKey: ["admin-org-twilio", orgId],
    queryFn: async () => {
      const res = await apiFetch(`/api/voice/orgs/${encodeURIComponent(orgId)}/twilio`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load Twilio status");
      return res.json();
    },
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["admin-org-twilio", orgId] });
  }

  async function runAction(path: string, body?: unknown) {
    setActionError(null);
    const res = await apiFetch(`/api/voice/orgs/${encodeURIComponent(orgId)}/twilio/${path}`, {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}) as { error?: string });
    if (!res.ok) {
      setActionError(data.error ?? `Request failed (${res.status})`);
      return false;
    }
    invalidate();
    return true;
  }

  const createSubaccount = useMutation({ mutationFn: () => runAction("subaccount") });
  const buyNumber = useMutation({ mutationFn: () => runAction("number", { countryCode, areaCode: areaCode || undefined }) });
  const setByo = useMutation({
    mutationFn: async () => {
      const ok = await runAction("byo", { accountSid: byoSid, authToken: byoToken, phoneNumber: byoNumber });
      if (ok) {
        setShowByoForm(false);
        setByoSid("");
        setByoToken("");
        setByoNumber("");
      }
      return ok;
    },
  });
  const reset = useMutation({ mutationFn: () => runAction("reset") });

  const t = status.data?.twilio;
  const anyPending = createSubaccount.isPending || buyNumber.isPending || setByo.isPending || reset.isPending;

  return (
    <div className="space-y-3">
      <h4 className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <Phone className="size-3.5" />
        Telephony (Twilio)
      </h4>

      {status.isLoading && <p className="text-muted-foreground">Loading…</p>}

      {t && (
        <div className="space-y-2">
          <div className="flex justify-between border-b border-border pb-1">
            <span>Mode</span>
            <span className="font-medium">
              {t.mode === "byo" ? "Bring your own" : t.usingGlobalDefault ? "Platform (global default)" : "Platform sub-account"}
            </span>
          </div>
          <div className="flex justify-between border-b border-border pb-1">
            <span>Account SID</span>
            <span className="font-mono">{t.usingGlobalDefault ? "(shared)" : maskSid(t.accountSid)}</span>
          </div>
          <div className="flex justify-between border-b border-border pb-1">
            <span>Outbound number</span>
            <span className="font-mono">{t.outboundNumber ?? "(none — falls back to platform default)"}</span>
          </div>

          {actionError && <p className="text-destructive">{actionError}</p>}

          {!showByoForm ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {t.mode === "platform" && t.usingGlobalDefault && (
                <button
                  onClick={() => createSubaccount.mutate()}
                  disabled={anyPending}
                  className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50"
                >
                  {createSubaccount.isPending && <Loader2 className="size-3 animate-spin" />}
                  Create Twilio sub-account
                </button>
              )}
              {t.mode === "platform" && !t.usingGlobalDefault && (
                <div className="flex items-center gap-1.5">
                  <input
                    value={countryCode}
                    onChange={(e) => setCountryCode(e.target.value)}
                    placeholder="US"
                    className="w-14 rounded border border-border bg-background px-1.5 py-1 text-center font-mono"
                  />
                  <input
                    value={areaCode}
                    onChange={(e) => setAreaCode(e.target.value)}
                    placeholder="area code (optional)"
                    className="w-36 rounded border border-border bg-background px-1.5 py-1"
                  />
                  <button
                    onClick={() => buyNumber.mutate()}
                    disabled={anyPending}
                    className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50"
                  >
                    {buyNumber.isPending && <Loader2 className="size-3 animate-spin" />}
                    Buy a number
                  </button>
                </div>
              )}
              <button
                onClick={() => setShowByoForm(true)}
                disabled={anyPending}
                className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50"
              >
                Use my own Twilio account
              </button>
              {!t.usingGlobalDefault && (
                <button
                  onClick={() => reset.mutate()}
                  disabled={anyPending}
                  className="inline-flex items-center gap-1 rounded border border-destructive/30 px-2.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  {reset.isPending && <Loader2 className="size-3 animate-spin" />}
                  Reset to platform default
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2 rounded border border-border p-3">
              <input
                value={byoSid}
                onChange={(e) => setByoSid(e.target.value)}
                placeholder="Account SID (AC...)"
                className="w-full rounded border border-border bg-background px-2 py-1 font-mono"
              />
              <input
                value={byoToken}
                onChange={(e) => setByoToken(e.target.value)}
                placeholder="Auth token"
                type="password"
                className="w-full rounded border border-border bg-background px-2 py-1 font-mono"
              />
              <input
                value={byoNumber}
                onChange={(e) => setByoNumber(e.target.value)}
                placeholder="Phone number (+15551234567)"
                className="w-full rounded border border-border bg-background px-2 py-1 font-mono"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setByo.mutate()}
                  disabled={setByo.isPending || !byoSid || !byoToken || !byoNumber}
                  className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {setByo.isPending && <Loader2 className="size-3 animate-spin" />}
                  Save & validate
                </button>
                <button
                  onClick={() => {
                    setShowByoForm(false);
                    setActionError(null);
                  }}
                  className="rounded border border-border px-2.5 py-1 hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
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

  const rows = orgs.data?.orgs ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="size-5 text-primary" />
          Organizations
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          Overview of all user workspaces, seats, agents, and store connection status.
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
                    <h3 className="text-sm font-semibold">Workspace Details</h3>

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

                        <div className="sm:col-span-2">
                          <TwilioSection orgId={org.id} />
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
