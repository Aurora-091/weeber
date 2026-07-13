import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Settings, User, Building2, Bell } from "lucide-react";
import { useUser } from "../../components/app/user-shell";
import { appFetch } from "../../lib/user-session";
import { supabase } from "../../lib/supabase";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

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
    <section className="rounded-lg border border-border bg-card p-6">
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
  const [timezone, setTimezone] = useState(me.org.timezone ?? "Asia/Kolkata");
  const [countryCode, setCountryCode] = useState(me.org.countryCode ?? "IN");
  const [contactEmail, setContactEmail] = useState(me.org.contactEmail ?? "");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    setOrgName(me.org.name ?? "");
    setTimezone(me.org.timezone ?? "Asia/Kolkata");
    setCountryCode(me.org.countryCode ?? "IN");
    setContactEmail(me.org.contactEmail ?? "");
  }, [me.org]);

  const saveOrg = useMutation({
    mutationFn: async () => {
      const res = await appFetch("/api/app/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: orgName, timezone, countryCode, contactEmail: contactEmail || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-me"] });
      toast.success("Organization settings saved");
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
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <>
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
            <div className="grid gap-4 sm:grid-cols-3 max-w-2xl">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Current password</Label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">New password</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 8 characters"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Confirm new password</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
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

        <Section icon={Bell} title="Notifications">
          <p className="text-sm text-muted-foreground">
            Notification preferences are coming soon. You'll be able to control alerts for call events, weekly digests, and billing updates.
          </p>
        </Section>
      </div>
    </>
  );
}
