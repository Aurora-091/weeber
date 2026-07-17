import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Settings, User, Building2, Bell, Webhook, ShieldAlert, FileCheck, PhoneForwarded } from "lucide-react";
import { useUser } from "../../components/app/user-shell";
import { appFetch } from "../../lib/user-session";
import { supabase } from "../../lib/supabase";
import { VERTICAL_OPTIONS } from "../../lib/verticals";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";

const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const COUNTRIES = [
  { code: "IN", label: "India" },
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "AE", label: "UAE" },
  { code: "AU", label: "Australia" },
  { code: "CA", label: "Canada" },
  { code: "SG", label: "Singapore" },
  { code: "DE", label: "Germany" },
  { code: "JP", label: "Japan" },
];

function Section({ icon: Icon, title, children }: { icon: typeof Settings; title: string; children: React.ReactNode }) {
  return (
    <section className="card-weeber p-6">
      <div className="flex items-center gap-2.5 mb-5">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function UserSettingsPage() {
  const { me } = useUser();
  const queryClient = useQueryClient();

  const [orgName, setOrgName] = useState(me.org.name ?? "");
  const [vertical, setVertical] = useState(me.org.vertical ?? "shopify");
  const [timezone, setTimezone] = useState(me.org.timezone ?? "Asia/Kolkata");
  const [countryCode, setCountryCode] = useState(me.org.countryCode ?? "IN");
  const [contactEmail, setContactEmail] = useState(me.org.contactEmail ?? "");
  const [webhookUrl, setWebhookUrl] = useState(me.org.webhookUrl ?? "");
  const [humanTransferNumber, setHumanTransferNumber] = useState(me.org.humanTransferNumber ?? "");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    setOrgName(me.org.name ?? "");
    setVertical(me.org.vertical ?? "shopify");
    setTimezone(me.org.timezone ?? "Asia/Kolkata");
    setCountryCode(me.org.countryCode ?? "IN");
    setContactEmail(me.org.contactEmail ?? "");
    setWebhookUrl(me.org.webhookUrl ?? "");
    setHumanTransferNumber(me.org.humanTransferNumber ?? "");
  }, [me.org]);

  const saveOrg = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: orgName,
          vertical,
          timezone,
          countryCode,
          contactEmail: contactEmail || null,
          webhookUrl: webhookUrl || null,
          humanTransferNumber: humanTransferNumber || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-me"] });
      // Vertical drives which agent templates/dashboard metrics show —
      // both need a refetch, not just the org record itself.
      queryClient.invalidateQueries({ queryKey: ["app-agent-configs"] });
      queryClient.invalidateQueries({ queryKey: ["app-analytics"] });
      toast.success("Organization settings saved");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const testWebhook = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/webhooks/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl || undefined }),
      });
      const data = await res.json().catch(() => ({ error: "Unknown error" }));
      if (!res.ok) throw new Error(data.error ?? "Failed to send test event");
      return data as { sent: boolean; target: string };
    },
    onSuccess: (data) => {
      toast.success(`Test event sent to ${data.target}`);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const changePassword = useMutation({
    mutationFn: async () => {
      if (newPassword.length < 8) throw new Error("Password must be at least 8 characters");
      if (newPassword !== confirmPassword) throw new Error("Passwords don't match");
      const { error } = await supabase!.auth.updateUser({ password: newPassword });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const testModeUntil = me.org.callingWindowTestModeUntil ? new Date(me.org.callingWindowTestModeUntil) : null;
  const testModeActive = Boolean(testModeUntil && testModeUntil.getTime() > Date.now());

  const testMode = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await appFetch("/api/app/compliance/test-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => ({ error: "Unknown error" }));
      if (!res.ok) throw new Error(data.error ?? "Failed to update test mode");
      return data as { callingWindowTestModeUntil: string | null };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["app-me"] });
      toast.success(data.callingWindowTestModeUntil ? "Test mode on for 24 hours" : "Test mode off");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Consent ledger summary (Marketing + Consent UI plan, 2026-07-16, Part B) — org-scoped counts
  // of active/withdrawn consent per purpose. See voice/routes.ts's checkOutboundCallCompliance for
  // what "active" means (granted, not withdrawn, not expired) — kept in sync deliberately.
  const consentSummary = useQuery<{
    activeByPurpose: Record<string, number>;
    withdrawnByPurpose: Record<string, number>;
    totalRecords: number;
  }>({
    queryKey: ["app-consent-summary"],
    queryFn: async () => {
      const res = await appFetch("/api/app/compliance/consent-summary");
      if (!res.ok) throw new Error("Failed to load consent summary");
      return res.json();
    },
  });

  // Insurance producer licensing (2026-07-16,
  // docs/agent-prompts/00-insurance-regulatory-reference.md, "Platform gaps" #2) — manual-entry
  // MVP: which states each licensed advisor covers, checked by checkInsuranceProducerLicensing
  // before any insurance-vertical call transfers/books to that advisor. Only rendered when this
  // org's vertical is "insurance" — see the JSX below.
  type InsuranceAdvisor = { id: number; name: string; npn: string | null; licensedStates: string[] };
  const advisors = useQuery<{ advisors: InsuranceAdvisor[] }>({
    queryKey: ["app-insurance-advisors"],
    queryFn: async () => {
      const res = await appFetch("/api/app/insurance-advisors");
      if (!res.ok) throw new Error("Failed to load advisors");
      return res.json();
    },
    enabled: me.org.vertical === "insurance",
  });
  const [advisorName, setAdvisorName] = useState("");
  const [advisorStates, setAdvisorStates] = useState("");
  const addAdvisor = useMutation({
    mutationFn: async () => {
      const licensedStates = advisorStates
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const res = await appFetch("/api/app/insurance-advisors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: advisorName.trim(), licensedStates }),
      });
      const data = await res.json().catch(() => ({ error: "Failed to add advisor" }));
      if (!res.ok) throw new Error(data.error ?? "Failed to add advisor");
      return data;
    },
    onSuccess: () => {
      setAdvisorName("");
      setAdvisorStates("");
      queryClient.invalidateQueries({ queryKey: ["app-insurance-advisors"] });
      toast.success("Advisor added");
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const removeAdvisor = useMutation({
    mutationFn: async (id: number) => {
      const res = await appFetch(`/api/app/insurance-advisors/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove advisor");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["app-insurance-advisors"] }),
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="page-enter">
      <PageHeader title="Settings" description="Manage your account and organization preferences." />

      <div className="space-y-6 mt-6">
        <Section icon={User} title="Account">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Email</Label>
              <Input value={me.user?.email ?? ""} disabled className="bg-muted/40" />
              <p className="text-[11px] text-muted-foreground">Email cannot be changed here.</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Role</Label>
              <Input value={me.role ?? "owner"} disabled className="bg-muted/40 capitalize" />
            </div>
          </div>

          <div className="mt-6 border-t border-border pt-5">
            <h3 className="text-xs font-medium text-muted-foreground mb-4">Change password</h3>
            <div className="grid gap-4 sm:grid-cols-2 max-w-lg">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">New password</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 8 characters"
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Confirm new password</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </div>
            </div>
            <Button
              size="sm"
              className="mt-4"
              disabled={!newPassword || changePassword.isPending}
              onClick={() => changePassword.mutate()}
            >
              {changePassword.isPending ? "Updating…" : "Update password"}
            </Button>
          </div>
        </Section>

        <Section icon={Building2} title="Organization">
          <div className="grid gap-5 sm:grid-cols-2 max-w-2xl">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Organization name</Label>
              <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="My Store" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Business type</Label>
              <select
                value={vertical}
                onChange={(e) => {
                  const next = e.target.value;
                  if (
                    next !== vertical &&
                    !confirm(
                      "Changing your business type switches which agents, dashboard metrics, and terminology you see. Your existing agent configs aren't deleted — they just won't show until you switch back. Continue?",
                    )
                  ) {
                    return;
                  }
                  setVertical(next);
                }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {VERTICAL_OPTIONS.map((v) => (
                  <option key={v.key} value={v.key}>{v.label}</option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                Picked once during setup — change it here if you skipped setup or picked wrong.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Contact email</Label>
              <Input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="support@mystore.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Timezone</Label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Country</Label>
              <select
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
            </div>
          </div>
          <Button
            size="sm"
            className="mt-5"
            disabled={saveOrg.isPending}
            onClick={() => saveOrg.mutate()}
          >
            {saveOrg.isPending ? "Saving…" : "Save changes"}
          </Button>
        </Section>

        <Section icon={PhoneForwarded} title="Human Transfer">
          <p className="mb-4 text-sm text-muted-foreground">
            The real phone number your agents transfer live calls to when a caller asks for a person, or
            an agent decides one is needed. <strong>Required for transfer-to-human to work at all</strong> —
            there's no shared/default number anymore (removed on purpose: a shared fallback used to risk
            silently routing another org's caller to your line). Leave blank and a transfer request will
            just end the call gracefully instead of connecting anywhere.
          </p>
          <div className="max-w-md space-y-1.5">
            <Label className="text-xs text-muted-foreground">Transfer number</Label>
            <Input
              type="tel"
              value={humanTransferNumber}
              onChange={(e) => setHumanTransferNumber(e.target.value)}
              placeholder="+15551234567"
            />
          </div>
          <div className="mt-5">
            <Button size="sm" disabled={saveOrg.isPending} onClick={() => saveOrg.mutate()}>
              {saveOrg.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </Section>

        <Section icon={Webhook} title="Webhooks">
          <p className="mb-4 text-sm text-muted-foreground">
            Get call events (started, completed, recording ready) pushed to n8n, Zapier, Make, or your own
            endpoint. Leave blank to use the <code className="font-mono text-xs">WEBHOOK_URL</code> default, if set.
          </p>
          <div className="max-w-md space-y-1.5">
            <Label className="text-xs text-muted-foreground">Webhook URL</Label>
            <Input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-n8n-instance/webhook/abc123"
            />
          </div>
          <div className="mt-5 flex gap-2">
            <Button size="sm" disabled={saveOrg.isPending} onClick={() => saveOrg.mutate()}>
              {saveOrg.isPending ? "Saving…" : "Save changes"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={testWebhook.isPending}
              onClick={() => testWebhook.mutate()}
            >
              {testWebhook.isPending ? "Sending…" : "Send test event"}
            </Button>
          </div>
        </Section>

        <Section icon={ShieldAlert} title="Compliance">
          <p className="mb-4 text-sm text-muted-foreground">
            For testing only — bypasses the TCPA/TRAI calling-window check (e.g. calling outside 9am-9pm)
            so you can place test calls any time of day. The Do Not Call list is <strong>always</strong>{" "}
            enforced regardless — there's no way to bypass that. Auto-turns off after 24 hours so it can't
            be accidentally left on in production.
          </p>
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={testModeActive}
              disabled={testMode.isPending}
              onCheckedChange={(checked) => testMode.mutate(checked)}
              aria-label="Calling-window compliance test mode"
            />
            <span className="font-medium">
              {testModeActive ? "Test mode is ON" : "Test mode is off"}
            </span>
          </label>
          {testModeActive && testModeUntil && (
            <p className="mt-2 text-xs text-muted-foreground">
              Turns back on automatically at {testModeUntil.toLocaleString()}.
            </p>
          )}

          <div className="mt-6 pt-6 border-t border-border">
            <div className="flex items-center gap-1.5 mb-2">
              <FileCheck className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Consent on file</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              How many of your contacts have active consent, by purpose. Consent for one purpose (e.g.
              marketing) never covers a different purpose (e.g. underwriting) — each is checked separately
              before a call goes out.
            </p>
            {consentSummary.isLoading && (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
            {consentSummary.data && consentSummary.data.totalRecords === 0 && (
              <p className="text-xs text-muted-foreground">No consent records on file yet.</p>
            )}
            {consentSummary.data && consentSummary.data.totalRecords > 0 && (
              <div className="flex flex-wrap gap-3 text-xs">
                {Object.entries(consentSummary.data.activeByPurpose).map(([purpose, count]) => (
                  <span key={purpose} className="rounded-md border border-border px-2.5 py-1.5">
                    <span className="font-medium">{count}</span>{" "}
                    <span className="text-muted-foreground">{purpose} (active)</span>
                  </span>
                ))}
                {Object.entries(consentSummary.data.withdrawnByPurpose).map(([purpose, count]) => (
                  <span key={`withdrawn-${purpose}`} className="rounded-md border border-border px-2.5 py-1.5 text-muted-foreground">
                    <span className="font-medium">{count}</span> {purpose} (withdrawn)
                  </span>
                ))}
              </div>
            )}
          </div>

          {me.org.vertical === "insurance" && (
            <div className="mt-6 pt-6 border-t border-border">
              <div className="flex items-center gap-1.5 mb-2">
                <FileCheck className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Licensed advisors</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                A US producer must be licensed in the state a prospect lives in. Add each advisor
                you transfer calls to and the states they're licensed in — a call to a lead in a
                state none of your advisors cover will be blocked automatically instead of
                transferring anyway.
              </p>

              {advisors.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
              {advisors.data && advisors.data.advisors.length === 0 && (
                <p className="text-xs text-muted-foreground mb-3">No advisors on file yet.</p>
              )}
              {advisors.data && advisors.data.advisors.length > 0 && (
                <div className="space-y-2 mb-3">
                  {advisors.data.advisors.map((a) => (
                    <div key={a.id} className="flex items-center justify-between text-xs rounded-md border border-border px-3 py-2">
                      <div>
                        <span className="font-medium">{a.name}</span>{" "}
                        <span className="text-muted-foreground">— {a.licensedStates.join(", ")}</span>
                      </div>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive h-6 px-2" onClick={() => removeAdvisor.mutate(a.id)}>
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1">
                  <Label className="text-xs">Advisor name</Label>
                  <Input value={advisorName} onChange={(e) => setAdvisorName(e.target.value)} placeholder="Jane Smith" className="h-8 w-48 text-xs" />
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs">Licensed states (comma-separated)</Label>
                  <Input value={advisorStates} onChange={(e) => setAdvisorStates(e.target.value)} placeholder="NY, NJ, CT" className="h-8 w-48 text-xs" />
                </div>
                <Button
                  size="sm"
                  onClick={() => addAdvisor.mutate()}
                  disabled={addAdvisor.isPending || !advisorName.trim() || !advisorStates.trim()}
                >
                  Add
                </Button>
              </div>
            </div>
          )}
        </Section>

        <Section icon={Bell} title="Notifications">
          <p className="text-sm text-muted-foreground">
            Notification preferences are coming soon. You'll be able to control alerts for call events, weekly digests, and billing updates.
          </p>
        </Section>
      </div>
    </div>
  );
}
