import { useQuery } from "@tanstack/react-query";
import { Store, CheckCircle2, XCircle, ExternalLink, ShieldCheck } from "lucide-react";
import { appFetch } from "../../lib/merchant-session";
import { useMerchant } from "../../components/app/merchant-shell";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";

type ShopifyStatus = {
  shops: { shop: string; connectedAt: string; disconnectedAt: string | null; scopes: string[] | null }[];
  hasShop: boolean;
  enabledAgentCount: number;
  installUrl: string | null;
};

export function MerchantShopifyPage() {
  const { me } = useMerchant();

  const statusQuery = useQuery<ShopifyStatus>({
    queryKey: ["app-shopify-status", me.org.id],
    queryFn: async () => {
      const res = await appFetch("/api/app/shopify/status");
      if (!res.ok) throw new Error(`Shopify status failed (${res.status})`);
      return res.json();
    },
  });

  const data = statusQuery.data;
  const activeShop = data?.shops.find((s) => !s.disconnectedAt);

  return (
    <div className="space-y-8 font-sans text-foreground bg-background">
      <PageHeader
        title="Shopify Integration"
        description="Connect your store and review OAuth access configurations."
      />

      {statusQuery.isLoading && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Loading Shopify integration status…
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
                      Connected to <strong className="font-mono">{activeShop.shop}</strong>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs text-destructive mt-1">
                      <XCircle className="size-3.5" />
                      No Shopify store connected
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-1 max-w-md">
                    Weeber hooks into your store's checkouts and orders to run outbound voice recovery campaigns.
                  </p>
                </div>
              </div>

              <div>
                {data.installUrl ? (
                  <Button asChild text-xs>
                    <a href={data.installUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5">
                      {activeShop ? "Reconnect Store" : "Connect Shopify Store"}
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">Installation URL is not configured.</p>
                )}
              </div>
            </div>
          </div>

          {/* Connection History and Details */}
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

          {/* Integration Troubleshooting */}
          <div className="rounded-lg border border-border p-5 space-y-3">
            <h3 className="text-sm font-semibold">Troubleshooting</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              If calls are not triggering on checkout abandonments or orders, ensure:
              <br />
              1. Your store webhook triggers are active in Shopify settings.
              <br />
              2. Your outbound caller ID phone number is verified and formatted in correct E.164 syntax.
              <br />
              3. If you still encounter issues, click <strong>Reconnect Store</strong> above to refresh OAuth credentials.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
