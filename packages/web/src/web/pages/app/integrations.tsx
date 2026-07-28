import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Store,
  Circle as XCircle,
  ExternalLink,
  ShieldCheck,
  ArrowRight,
  Loader as Loader2,
  ChevronDown,
  RefreshCw,
  ShoppingBag,
  Building2,
  FileSpreadsheet,
  Download,
  PhoneCall,
  ClipboardList,
  Phone,
} from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { INTEGRATIONS_NAV_LABEL } from "../../lib/verticals";
import { useUser } from "../../components/app/user-shell";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../components/ui/dialog";

type ShopifyStatus = {
  shops: { shop: string; connectedAt: string; disconnectedAt: string | null; scopes: string[] | null }[];
  hasShop: boolean;
  enabledAgentCount: number;
  installUrl: string | null;
};

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffMinutes > 0) return `${diffMinutes} minute${diffMinutes > 1 ? "s" : ""} ago`;
  return "just now";
}

/** Compact summary tile in the platform grid — Shopify is live, others are placeholders for what's next. */
function PlatformTile({
  icon: Icon,
  name,
  status,
}: {
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  status: "connected" | "not-connected" | "coming-soon";
}) {
  return (
    <div
      className={`flex items-center gap-3 p-5 rounded-lg border bg-card transition-colors duration-150 ${
        status === "coming-soon"
          ? "opacity-50 border-dashed border-border"
          : "card-weeber card-lift"
      }`}
    >
      <Icon className="size-7 text-primary shrink-0" />
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold">{name}</h3>
        {status === "connected" && (
          <div className="flex items-center gap-1.5 text-xs text-success mt-0.5">
            <span className="inline-block size-2 rounded-full bg-success pulse-dot" />
            Connected
          </div>
        )}
        {status === "not-connected" && (
          <div className="flex items-center gap-1.5 text-xs text-destructive mt-0.5">
            <XCircle className="size-3.5" />
            Not connected
          </div>
        )}
        {status === "coming-soon" && <p className="text-xs text-muted-foreground mt-0.5">Coming soon</p>}
      </div>
    </div>
  );
}

/** One "Download as Excel" export card. */
function ExportCard({
  icon: Icon,
  title,
  description,
  path,
  filename,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  path: string;
  filename: string;
}) {
  const downloadMutation = useMutation({
    mutationFn: async () => {
      const res = await appFetch(path);
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      return res.blob();
    },
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`${title} exported`);
    },
    onError: () => {
      toast.error(`Couldn't export ${title.toLowerCase()} — try again.`);
    },
  });

  return (
    <div className="card-weeber card-lift flex flex-col gap-3 p-5">
      <div className="flex items-start gap-3">
        <Icon className="size-6 text-primary shrink-0" />
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 self-start"
        disabled={downloadMutation.isPending}
        onClick={() => downloadMutation.mutate()}
      >
        {downloadMutation.isPending ? (
          <>
            <Loader2 className="size-3.5 animate-spin" />
            Preparing...
          </>
        ) : (
          <>
            <Download className="size-3.5" />
            Download as Excel
          </>
        )}
      </Button>
    </div>
  );
}

type TwilioSubStatus = {
  mode: "platform" | "byo";
  accountSid: string | null;
  outboundNumber: string | null;
  usingGlobalDefault: boolean;
};
type PlivoSubStatus = { connected: boolean; authId: string | null };
type ExotelSubStatus = { connected: boolean; sid: string | null; subdomain: string | null };

type TelephonyStatus = {
  /** Which provider is actually live for this org's calls right now. */
  provider: "twilio" | "plivo" | "exotel";
  outboundNumber: string | null;
  twilio: TwilioSubStatus;
  plivo: PlivoSubStatus;
  exotel: ExotelSubStatus;
};

/** One telephony provider tile — mirrors the Shopify/WooCommerce/BigCommerce
 * card pattern above. Twilio has a platform-owned provisioning path
 * (dedicated sub-account + bought number) on top of BYO; Plivo and Exotel
 * are BYO-only today (see voice/plivo-provisioning.ts,
 * voice/exotel-provisioning.ts, and docs/india-telephony.md for why —
 * Exotel in particular needs a SIP bridge for live calls that doesn't
 * exist yet, so connecting credentials here records the account but
 * doesn't yet route real traffic through it). */
function TelephonyProviderTile({
  name,
  connected,
  onConnect,
  comingSoon,
}: {
  name: string;
  connected?: boolean;
  onConnect?: () => void;
  comingSoon?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 p-5 rounded-lg border bg-card transition-colors duration-150 ${
        comingSoon
          ? "opacity-50 border-dashed border-border"
          : "card-weeber card-lift"
      }`}
    >
      <Phone className="size-7 text-primary shrink-0" />
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold">{name}</h3>
        {comingSoon ? (
          <p className="text-xs text-muted-foreground mt-0.5">Coming soon</p>
        ) : connected ? (
          <div className="flex items-center gap-1.5 text-xs text-success mt-0.5">
            <span className="inline-block size-2 rounded-full bg-success pulse-dot" />
            Connected
          </div>
        ) : (
          <p className="text-xs text-muted-foreground mt-0.5">Not connected</p>
        )}
      </div>
      {!comingSoon && (
        <Button variant="outline" size="sm" onClick={onConnect}>
          {connected ? "Manage" : "Connect"}
        </Button>
      )}
    </div>
  );
}

export function UserIntegrationsPage() {
  const { me } = useUser();
  const [storeDomain, setStoreDomain] = useState("");
  // True for the brief window between landing back from weebersh's redirect
  // and the forced status refetch resolving — fills the gap so the page
  // doesn't sit there looking inert before the success/error toast fires.
  const [confirmingConnection, setConfirmingConnection] = useState(false);
  const queryClient = useQueryClient();

  const statusQuery = useQuery<ShopifyStatus>({
    queryKey: ["app-shopify-status", me.org.id],
    queryFn: async () => {
      const res = await appFetch("/api/app/shopify/status");
      if (!res.ok) throw new Error(`Shopify status failed (${res.status})`);
      return res.json();
    },
  });

  // weebersh redirects the browser back here (via the return_url stamped
  // into the install URL by buildInstallUrl) once its OAuth flow + the
  // server-to-server /connected callback both complete. Force a fresh
  // status fetch right away instead of trusting cache, and surface a clear
  // signal if the callback didn't actually land (org_id mismatch, dropped
  // callback, etc.) rather than leaving the user staring at a stale
  // "not connected" card with no explanation.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("shopify_connected") !== "1" && params.get("connected") !== "1") return;

    window.history.replaceState({}, "", window.location.pathname);
    setConfirmingConnection(true);

    void queryClient
      .invalidateQueries({ queryKey: ["app-shopify-status", me.org.id] })
      .then(() => queryClient.fetchQuery({ queryKey: ["app-shopify-status", me.org.id] }))
      .then((fresh) => {
        const status = fresh as ShopifyStatus | undefined;
        if (status?.hasShop) {
          toast.success("Shopify store connected");
        } else {
          toast.error(
            "weebersh reported a successful connection, but Weeber didn't receive it — the store isn't linked to your account yet. Try connecting again, or contact support if this repeats.",
          );
        }
      })
      .catch(() => {
        toast.error("Couldn't confirm Shopify connection status — refresh the page to check again.");
      })
      .finally(() => setConfirmingConnection(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.org.id]);

  // Now that the OAuth-initiating navigation is always same-tab (issues 4+5
  // fix — no more window.open popup), this mostly just covers a merchant
  // manually reconnecting from a bookmark/second tab. Kept as a cheap,
  // harmless general "keep status fresh" behavior.
  useEffect(() => {
    const refetch = () => {
      if (document.visibilityState === "visible") {
        void queryClient.invalidateQueries({ queryKey: ["app-shopify-status", me.org.id] });
      }
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [queryClient, me.org.id]);

  // --- Telephony (BYO/dedicated number) ---
  const [telephonyDialog, setTelephonyDialog] = useState<"twilio" | "plivo" | "exotel" | null>(null);
  const [twilioForm, setTwilioForm] = useState({ accountSid: "", authToken: "", phoneNumber: "" });
  const [plivoForm, setPlivoForm] = useState({ authId: "", authToken: "", phoneNumber: "" });
  const [exotelForm, setExotelForm] = useState({ sid: "", apiKey: "", apiToken: "", subdomain: "", phoneNumber: "" });
  const [numberCountryCode, setNumberCountryCode] = useState("US");
  const [numberAreaCode, setNumberAreaCode] = useState("");

  const telephonyStatusQuery = useQuery<TelephonyStatus>({
    queryKey: ["app-telephony-status", me.org.id],
    queryFn: async () => {
      const res = await appFetch("/api/app/telephony/status");
      if (!res.ok) throw new Error(`Telephony status failed (${res.status})`);
      const data = await res.json();
      return data.telephony as TelephonyStatus;
    },
  });

  const invalidateTelephony = () => queryClient.invalidateQueries({ queryKey: ["app-telephony-status", me.org.id] });

  const twilioByoMutation = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/telephony/byo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(twilioForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to connect Twilio");
      return data;
    },
    onSuccess: () => {
      toast.success("Twilio connected");
      setTelephonyDialog(null);
      setTwilioForm({ accountSid: "", authToken: "", phoneNumber: "" });
      void invalidateTelephony();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const plivoByoMutation = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/telephony/plivo/byo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plivoForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to connect Plivo");
      return data;
    },
    onSuccess: () => {
      toast.success("Plivo connected");
      setTelephonyDialog(null);
      setPlivoForm({ authId: "", authToken: "", phoneNumber: "" });
      void invalidateTelephony();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const exotelByoMutation = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/telephony/exotel/byo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exotelForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to connect Exotel");
      return data;
    },
    onSuccess: () => {
      toast.success("Exotel connected — credentials saved, but calls don't route through Exotel yet.");
      setTelephonyDialog(null);
      setExotelForm({ sid: "", apiKey: "", apiToken: "", subdomain: "", phoneNumber: "" });
      void invalidateTelephony();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const dedicatedNumberMutation = useMutation({
    mutationFn: async () => {
      const subRes = await appFetch("/api/app/telephony/subaccount", { method: "POST" });
      const subData = await subRes.json().catch(() => ({}));
      if (!subRes.ok) throw new Error(subData.error ?? "Failed to provision a Twilio sub-account");

      const numRes = await appFetch("/api/app/telephony/number", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ countryCode: numberCountryCode, areaCode: numberAreaCode || undefined }),
      });
      const numData = await numRes.json().catch(() => ({}));
      if (!numRes.ok) throw new Error(numData.error ?? "Failed to purchase a number");
      return numData;
    },
    onSuccess: (data) => {
      toast.success(`Dedicated number provisioned: ${data.phoneNumber}`);
      void invalidateTelephony();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const telephonyResetMutation = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/telephony/reset", { method: "POST" });
      if (!res.ok) throw new Error("Failed to reset telephony settings");
    },
    onSuccess: () => {
      toast.success("Reverted to platform default");
      void invalidateTelephony();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Full-page blurred loading overlay shown for the brief moment between
  // "install URL ready" and the actual same-tab redirect firing — audit
  // finding (issues 4+5): this used to open the OAuth flow in a new tab via
  // window.open(), which is exactly the kind of script-opened popup
  // Shopify's OAuth flow isn't reliably tested against (cookie/session-state
  // validation across the Shopify consent-screen redirect chain can break in
  // a popup context in ways it doesn't in a normal top-level navigation) --
  // that's the most likely cause of the "lands on weebersh's own OAuth
  // callback URL with a bare error page" failure. weebersh doesn't need a
  // popup either: it's a non-embedded app (isEmbeddedApp: false), so there's
  // no iframe to break out of. Same-tab redirect is both simpler and safer.
  const [redirectingToShopify, setRedirectingToShopify] = useState(false);

  const installMutation = useMutation({
    mutationFn: async (shop: string) => {
      const res = await appFetch("/api/app/shopify/install-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to generate install URL" }));
        throw new Error(err.error ?? "Failed to generate install URL");
      }
      return res.json() as Promise<{ installUrl: string }>;
    },
    onSuccess: (data) => {
      setRedirectingToShopify(true);
      // Brief pause so the blurred overlay is actually perceivable instead
      // of an instant jump — this is a real (if short) transition, not a
      // fake artificial delay to look busy.
      window.setTimeout(() => {
        window.location.href = data.installUrl;
      }, 500);
    },
  });

  const resyncMutation = useMutation({
    mutationFn: async () => {
      await queryClient.invalidateQueries({ queryKey: ["app-shopify-status", me.org.id] });
      return queryClient.fetchQuery({ queryKey: ["app-shopify-status", me.org.id] });
    },
    onSuccess: (fresh) => {
      const status = fresh as ShopifyStatus | undefined;
      // Honest copy (audit finding): this only re-reads Weeber's own already-stored DB row --
      // it does NOT re-verify anything with Shopify or weebersh (weebersh has no status/health
      // endpoint to check against today). "Refresh" + this wording avoids implying a live
      // re-sync happened. A real resync is filed as a follow-up (needs a new weebersh endpoint).
      toast.success(status?.hasShop ? "Refreshed — Weeber shows this store as connected" : "Refreshed — Weeber shows no store connected");
    },
    onError: () => toast.error("Couldn't refresh — try again."),
  });

  const data = statusQuery.data;
  const activeShop = data?.shops.find((s) => !s.disconnectedAt);

  const handleInstall = (e: React.FormEvent) => {
    e.preventDefault();
    const domain = storeDomain.trim();
    if (!domain) return;
    installMutation.mutate(domain);
  };

  return (
    <div className="page-enter space-y-6">
      {(redirectingToShopify || confirmingConnection) && (
        <div className="card-weeber p-4 border-primary/30 bg-primary/5 flex items-center gap-3">
          <Loader2 className="size-4 animate-spin text-primary shrink-0" />
          <p className="text-xs font-medium text-foreground">
            {redirectingToShopify ? "Redirecting you to Shopify…" : "Confirming connection with Shopify…"}
          </p>
        </div>
      )}

      <PageHeader
        title={INTEGRATIONS_NAV_LABEL}
        description="Connect commerce platforms so your agents can react to checkouts, orders, and fulfillments — and export your data whenever you need it."
      />

      {/* Connected platforms grid */}
      <div>
        <h2 className="text-sm font-semibold mb-3">Platforms</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <PlatformTile icon={Store} name="Shopify" status={activeShop ? "connected" : "not-connected"} />
          <PlatformTile icon={ShoppingBag} name="WooCommerce" status="coming-soon" />
          <PlatformTile icon={Building2} name="BigCommerce" status="coming-soon" />
        </div>
      </div>

      {statusQuery.isLoading && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Loading Shopify integration status...
        </div>
      )}

      {data && (
        <div className="space-y-6 content-fade-in">
          {/* Manage Shopify */}
          <div className="card-weeber p-5">
            <div className="flex sm:flex-row flex-col justify-between sm:items-center gap-4">
              <div className="flex items-start gap-3">
                <Store className="size-8 text-primary shrink-0" />
                <div>
                  <h2 className="text-base font-semibold">Shopify — Store Connection</h2>
                  {activeShop ? (
                    <div className="flex items-center gap-1.5 text-xs text-success mt-1">
                      <span className="inline-block size-2 rounded-full bg-success pulse-dot" />
                      Connected to <strong className="font-mono ml-1">{activeShop.shop}</strong>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs text-destructive mt-1">
                      <XCircle className="size-3.5" />
                      No Shopify store connected
                    </div>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 self-start sm:self-auto"
                disabled={resyncMutation.isPending}
                onClick={() => resyncMutation.mutate()}
                title="Reloads what Weeber has stored — doesn't re-check Shopify or weebersh live"
              >
                <RefreshCw className={`size-3.5 ${resyncMutation.isPending ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>

          {/* Install / Connect Form */}
          {!activeShop && (
            <div className="card-weeber p-6">
              <h3 className="text-sm font-semibold mb-1">Connect your Shopify store</h3>
              <p className="text-xs text-muted-foreground mb-5 max-w-lg">
                Enter your Shopify store domain below. You'll be redirected to Shopify to authorize the Weeber app.
              </p>
              <form onSubmit={handleInstall} className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
                <div className="w-full sm:max-w-sm space-y-1.5">
                  <label htmlFor="store-domain" className="text-xs font-medium text-muted-foreground">
                    Store domain
                  </label>
                  <div className="relative">
                    <Input
                      id="store-domain"
                      placeholder="your-store"
                      value={storeDomain}
                      onChange={(e) => setStoreDomain(e.target.value)}
                      className="pr-32"
                      disabled={installMutation.isPending}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                      .myshopify.com
                    </span>
                  </div>
                </div>
                <Button
                  type="submit"
                  disabled={!storeDomain.trim() || installMutation.isPending}
                  className="gap-1.5"
                >
                  {installMutation.isPending ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Redirecting...
                    </>
                  ) : (
                    <>
                      Install on Shopify
                      <ArrowRight className="size-3.5" />
                    </>
                  )}
                </Button>
              </form>
              {installMutation.isError && (
                <p className="text-xs text-destructive mt-3">{installMutation.error.message}</p>
              )}
            </div>
          )}

          {/* Reconnect for already-connected shop (collapsed) */}
          {activeShop && (
            <details className="card-weeber">
              <summary className="cursor-pointer px-6 py-4 text-sm font-semibold hover:bg-muted/40 transition-colors list-none flex items-center justify-between">
                <span>Need to reconnect or switch stores?</span>
                <ChevronDown className="size-4 text-muted-foreground" />
              </summary>
              <div className="px-6 pb-6 pt-2">
                <p className="text-xs text-muted-foreground mb-5 max-w-lg">
                  Need to refresh OAuth credentials or switch stores? Enter the store domain below.
                </p>
                <form onSubmit={handleInstall} className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
                  <div className="w-full sm:max-w-sm space-y-1.5">
                    <label htmlFor="store-domain-reconnect" className="text-xs font-medium text-muted-foreground">
                      Store domain
                    </label>
                    <div className="relative">
                      <Input
                        id="store-domain-reconnect"
                        placeholder={activeShop.shop.replace(".myshopify.com", "")}
                        value={storeDomain}
                        onChange={(e) => setStoreDomain(e.target.value)}
                        className="pr-32"
                        disabled={installMutation.isPending}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                        .myshopify.com
                      </span>
                    </div>
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={!storeDomain.trim() || installMutation.isPending}
                    className="gap-1.5"
                  >
                    {installMutation.isPending ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        Redirecting...
                      </>
                    ) : (
                      <>
                        Reconnect Store
                        <ExternalLink className="size-3.5" />
                      </>
                    )}
                  </Button>
                </form>
                {installMutation.isError && (
                  <p className="text-xs text-destructive mt-3">{installMutation.error.message}</p>
                )}
              </div>
            </details>
          )}

          {/* Connection Details & Scopes */}
          {activeShop && (
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="card-weeber card-lift p-5">
                <h3 className="text-sm font-semibold">Connection Details</h3>
                <div className="mt-4 space-y-3 text-xs text-muted-foreground">
                  <div className="flex justify-between border-b border-border pb-2">
                    <span>Shop Domain</span>
                    <span className="font-mono text-foreground">{activeShop.shop}</span>
                  </div>
                  <div className="flex justify-between border-b border-border pb-2">
                    <span>Connected At</span>
                    <span className="text-foreground">{new Date(activeShop.connectedAt).toLocaleDateString()}</span>
                  </div>
                  <div className="flex justify-between border-b border-border pb-2">
                    <span>Last Connected</span>
                    <span className="text-foreground">Connected {relativeTime(activeShop.connectedAt)}</span>
                  </div>
                  <div className="flex justify-between pb-1">
                    <span>Active Shopify Agents</span>
                    <span className="text-foreground font-semibold">{data.enabledAgentCount} active</span>
                  </div>
                </div>
              </div>

              <div className="card-weeber card-lift p-5">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <ShieldCheck className="size-4 text-success" />
                  OAuth Scopes Approved
                </h3>
                <p className="text-xs text-muted-foreground mt-2">
                  Weeber has permission to read the following data from your Shopify store:
                </p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {(activeShop.scopes ?? ["read_checkouts", "read_orders", "write_orders", "read_customers"]).map((scope) => (
                    <span key={scope} className="rounded bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {scope}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Troubleshooting */}
          <div className="rounded-lg border border-border p-5 space-y-3">
            <h3 className="text-sm font-semibold">Troubleshooting</h3>
            <div className="space-y-2">
              <details className="group rounded-md border border-border">
                <summary className="cursor-pointer px-4 py-3 text-xs font-medium hover:bg-muted/40 transition-colors list-none flex items-center justify-between">
                  <span>Webhook triggers not firing</span>
                  <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="px-4 pb-3 pt-1 text-xs text-muted-foreground leading-relaxed">
                  Ensure your store webhook triggers are active in your Shopify admin settings. Navigate to <strong>Settings → Notifications → Webhooks</strong> and verify that the relevant events (e.g., checkout creation, order creation) are enabled and pointing to the correct endpoint. If webhooks were previously deleted or the app was reinstalled, you may need to reconnect.
                </div>
              </details>

              <details className="group rounded-md border border-border">
                <summary className="cursor-pointer px-4 py-3 text-xs font-medium hover:bg-muted/40 transition-colors list-none flex items-center justify-between">
                  <span>Calls not going out</span>
                  <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="px-4 pb-3 pt-1 text-xs text-muted-foreground leading-relaxed">
                  Make sure your outbound caller ID phone number is verified and formatted in correct E.164 syntax (e.g., <code className="font-mono text-foreground">+14155551234</code>). Numbers without the country code prefix or containing spaces/dashes will fail silently. Also check that the agent assigned to the campaign is enabled and has available call capacity.
                </div>
              </details>

              <details className="group rounded-md border border-border">
                <summary className="cursor-pointer px-4 py-3 text-xs font-medium hover:bg-muted/40 transition-colors list-none flex items-center justify-between">
                  <span>OAuth issues</span>
                  <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="px-4 pb-3 pt-1 text-xs text-muted-foreground leading-relaxed">
                  If you're encountering permission errors or stale token issues, use the reconnect form above to refresh your OAuth credentials. This will redirect you to Shopify to re-authorize the app with the latest required scopes. Your existing configuration and agent assignments will be preserved.
                </div>
              </details>
            </div>
          </div>
        </div>
      )}

      {/* Telephony / phone numbers */}
      <div>
        <h2 className="text-sm font-semibold mb-1">Telephony</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Every org gets its own dedicated number or brings its own — never a number shared across orgs.
        </p>
        <div className="grid gap-4 sm:grid-cols-3 mb-4">
          <TelephonyProviderTile
            name="Twilio"
            connected={telephonyStatusQuery.data?.provider === "twilio" && Boolean(telephonyStatusQuery.data?.outboundNumber)}
            onConnect={() => setTelephonyDialog("twilio")}
          />
          <TelephonyProviderTile
            name="Plivo"
            connected={Boolean(telephonyStatusQuery.data?.plivo.connected)}
            onConnect={() => setTelephonyDialog("plivo")}
          />
          <TelephonyProviderTile
            name="Exotel"
            connected={Boolean(telephonyStatusQuery.data?.exotel.connected)}
            onConnect={() => setTelephonyDialog("exotel")}
          />
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Only one provider can be active at a time — connecting Plivo or Exotel switches your org's number
          over to it. Exotel credentials are recorded but calls don't route through Exotel yet (needs a SIP
          bridge — see docs/india-telephony.md); Plivo and Twilio are both live today.
        </p>

        {telephonyStatusQuery.data && (
          <div className="card-weeber p-5">
            <div className="flex sm:flex-row flex-col justify-between sm:items-center gap-4">
              <div>
                <h3 className="text-sm font-semibold">Current number</h3>
                {telephonyStatusQuery.data.outboundNumber ? (
                  <p className="text-xs text-muted-foreground mt-1">
                    <span className="font-mono text-foreground">{telephonyStatusQuery.data.outboundNumber}</span>
                    {" — "}
                    {telephonyStatusQuery.data.provider === "twilio"
                      ? telephonyStatusQuery.data.twilio.mode === "byo"
                        ? "your own Twilio account (BYO)"
                        : "dedicated number, provisioned by Weeber"
                      : telephonyStatusQuery.data.provider === "plivo"
                        ? "your own Plivo account (BYO)"
                        : "your own Exotel account (BYO)"}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">
                    No dedicated number yet — currently riding the shared platform default.
                  </p>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                {!telephonyStatusQuery.data.outboundNumber && telephonyStatusQuery.data.provider === "twilio" && (
                  <>
                    <Input
                      value={numberCountryCode}
                      onChange={(e) => setNumberCountryCode(e.target.value.toUpperCase())}
                      placeholder="US"
                      className="w-16 text-center"
                      maxLength={2}
                    />
                    <Input
                      value={numberAreaCode}
                      onChange={(e) => setNumberAreaCode(e.target.value)}
                      placeholder="Area code (optional)"
                      className="w-40"
                    />
                    <Button
                      size="sm"
                      className="gap-1.5 shrink-0"
                      disabled={dedicatedNumberMutation.isPending}
                      onClick={() => dedicatedNumberMutation.mutate()}
                    >
                      {dedicatedNumberMutation.isPending ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Provisioning...
                        </>
                      ) : (
                        "Get a dedicated number"
                      )}
                    </Button>
                  </>
                )}
                {(telephonyStatusQuery.data.provider !== "twilio" ||
                  telephonyStatusQuery.data.twilio.mode === "byo" ||
                  telephonyStatusQuery.data.outboundNumber) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={telephonyResetMutation.isPending}
                    onClick={() => telephonyResetMutation.mutate()}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog open={telephonyDialog === "twilio"} onOpenChange={(open) => !open && setTelephonyDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Twilio</DialogTitle>
            <DialogDescription>Enter your credentials to connect your own Twilio account.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="twilio-sid">Account SID</Label>
              <Input
                id="twilio-sid"
                placeholder="Enter account SID"
                value={twilioForm.accountSid}
                onChange={(e) => setTwilioForm({ ...twilioForm, accountSid: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="twilio-token">Auth Token</Label>
              <Input
                id="twilio-token"
                type="password"
                placeholder="Enter auth token"
                value={twilioForm.authToken}
                onChange={(e) => setTwilioForm({ ...twilioForm, authToken: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="twilio-number">Phone Number</Label>
              <Input
                id="twilio-number"
                placeholder="Enter phone number"
                value={twilioForm.phoneNumber}
                onChange={(e) => setTwilioForm({ ...twilioForm, phoneNumber: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTelephonyDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                twilioByoMutation.isPending ||
                !twilioForm.accountSid.trim() ||
                !twilioForm.authToken.trim() ||
                !twilioForm.phoneNumber.trim()
              }
              onClick={() => twilioByoMutation.mutate()}
            >
              {twilioByoMutation.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin mr-1.5" />
                  Connecting...
                </>
              ) : (
                "Connect Twilio"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={telephonyDialog === "plivo"} onOpenChange={(open) => !open && setTelephonyDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Plivo</DialogTitle>
            <DialogDescription>Enter your credentials to connect your own Plivo account.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="plivo-auth-id">Auth ID</Label>
              <Input
                id="plivo-auth-id"
                placeholder="Enter Auth ID"
                value={plivoForm.authId}
                onChange={(e) => setPlivoForm({ ...plivoForm, authId: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plivo-auth-token">Auth Token</Label>
              <Input
                id="plivo-auth-token"
                type="password"
                placeholder="Enter Auth Token"
                value={plivoForm.authToken}
                onChange={(e) => setPlivoForm({ ...plivoForm, authToken: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plivo-number">Phone Number</Label>
              <Input
                id="plivo-number"
                placeholder="Enter phone number"
                value={plivoForm.phoneNumber}
                onChange={(e) => setPlivoForm({ ...plivoForm, phoneNumber: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTelephonyDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                plivoByoMutation.isPending ||
                !plivoForm.authId.trim() ||
                !plivoForm.authToken.trim() ||
                !plivoForm.phoneNumber.trim()
              }
              onClick={() => plivoByoMutation.mutate()}
            >
              {plivoByoMutation.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin mr-1.5" />
                  Connecting...
                </>
              ) : (
                "Connect Plivo"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={telephonyDialog === "exotel"} onOpenChange={(open) => !open && setTelephonyDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Exotel</DialogTitle>
            <DialogDescription>
              Enter your credentials to connect your own Exotel account. Note: calls don't route through
              Exotel yet — this records your account for when the integration ships.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="exotel-sid">Account SID</Label>
              <Input
                id="exotel-sid"
                placeholder="Enter account SID"
                value={exotelForm.sid}
                onChange={(e) => setExotelForm({ ...exotelForm, sid: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exotel-api-key">API Key</Label>
              <Input
                id="exotel-api-key"
                placeholder="Enter API Key"
                value={exotelForm.apiKey}
                onChange={(e) => setExotelForm({ ...exotelForm, apiKey: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exotel-api-token">API Token</Label>
              <Input
                id="exotel-api-token"
                type="password"
                placeholder="Enter API Token"
                value={exotelForm.apiToken}
                onChange={(e) => setExotelForm({ ...exotelForm, apiToken: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exotel-subdomain">API Subdomain (optional)</Label>
              <Input
                id="exotel-subdomain"
                placeholder="api.exotel.com"
                value={exotelForm.subdomain}
                onChange={(e) => setExotelForm({ ...exotelForm, subdomain: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exotel-number">Phone Number</Label>
              <Input
                id="exotel-number"
                placeholder="Enter phone number"
                value={exotelForm.phoneNumber}
                onChange={(e) => setExotelForm({ ...exotelForm, phoneNumber: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTelephonyDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                exotelByoMutation.isPending ||
                !exotelForm.sid.trim() ||
                !exotelForm.apiKey.trim() ||
                !exotelForm.apiToken.trim() ||
                !exotelForm.phoneNumber.trim()
              }
              onClick={() => exotelByoMutation.mutate()}
            >
              {exotelByoMutation.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin mr-1.5" />
                  Connecting...
                </>
              ) : (
                "Connect Exotel"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Data export */}
      <div>
        <h2 className="text-sm font-semibold mb-1">Export Data</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Download a spreadsheet snapshot any time — no live sync, just an on-demand .xlsx.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <ExportCard
            icon={ClipboardList}
            title="Orders"
            description="Cart recovery, COD confirmation, and feedback call attempts, with recovered order value."
            path="/api/app/export/orders.xlsx"
            filename="orders.xlsx"
          />
          <ExportCard
            icon={PhoneCall}
            title="Call Analytics"
            description="Volume, duration, outcomes, and latency for every call."
            path="/api/app/export/analytics.xlsx"
            filename="call-analytics.xlsx"
          />
          <ExportCard
            icon={FileSpreadsheet}
            title="Transcripts"
            description="Full turn-by-turn transcripts for every call."
            path="/api/app/export/transcripts.xlsx"
            filename="transcripts.xlsx"
          />
        </div>
      </div>
    </div>
  );
}
