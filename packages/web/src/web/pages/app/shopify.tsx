import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Store, CircleCheck as CheckCircle2, Circle as XCircle, ExternalLink, ShieldCheck, ArrowRight, Loader as Loader2 } from "lucide-react";
import { appFetch } from "../../lib/merchant-session";
import { useMerchant } from "../../components/app/merchant-shell";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

type ShopifyStatus = {
  shops: { shop: string; connectedAt: string; disconnectedAt: string | null; scopes: string[] | null }[];
  hasShop: boolean;
  enabledAgentCount: number;
  installUrl: string | null;
};

export function MerchantShopifyPage() {
  const { me } = useMerchant();
  const [storeDomain, setStoreDomain] = useState("");

  const statusQuery = useQuery<ShopifyStatus>({
    queryKey: ["app-shopify-status", me.org.id],
    queryFn: async () => {
      const res = await appFetch("/api/app/shopify/status");
      if (!res.ok) throw new Error(`Shopify status failed (${res.status})`);
      return res.json();
    },
  });

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
      window.location.href = data.installUrl;
    },
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
    <div className="space-y-8 font-sans text-foreground bg-background">
      <PageHeader
        title="Shopify Integration"
        description="Connect your Shopify store to enable voice-powered cart recovery, COD confirmation, and post-delivery feedback."
      />

      {statusQuery.isLoading && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Loading Shopify integration status...
        </div>
      )}

      {data && (
        <div className="space-y-6 content-fade-in">
          {/* Connection Status Card */}
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex sm:flex-row flex-col justify-between sm:items-center gap-4">
              <div className="flex items-start gap-3">
                <Store className="size-8 text-primary shrink-0" />
                <div>
                  <h2 className="text-base font-semibold">Store Connection</h2>
                  {activeShop ? (
                    <div className="flex items-center gap-1.5 text-xs text-success mt-1">
                      <CheckCircle2 className="size-3.5" />
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
            </div>
          </div>

          {/* Install / Connect Form */}
          {!activeShop && (
            <div className="rounded-lg border border-border bg-card p-6">
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

          {/* Reconnect for already-connected shop */}
          {activeShop && (
            <div className="rounded-lg border border-border bg-card p-6">
              <h3 className="text-sm font-semibold mb-1">Reconnect store</h3>
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
          )}

          {/* Connection Details & Scopes */}
          {activeShop && (
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-card p-5">
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
                  <div className="flex justify-between pb-1">
                    <span>Active Shopify Agents</span>
                    <span className="text-foreground font-semibold">{data.enabledAgentCount} active</span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-5">
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
            <p className="text-xs text-muted-foreground leading-relaxed">
              If calls are not triggering on checkout abandonments or orders, ensure:
              <br />
              1. Your store webhook triggers are active in Shopify settings.
              <br />
              2. Your outbound caller ID phone number is verified and formatted in correct E.164 syntax.
              <br />
              3. If you still encounter issues, use the reconnect form above to refresh OAuth credentials.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
