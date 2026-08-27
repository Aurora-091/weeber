import { PhoneCall, ShieldOff, ShieldCheck, KeyRound, Bot, ChartBar as BarChart3, Lock, Users, Building2, CreditCard, Shield, ScrollText, ListChecks, Send, LifeBuoy, History, TrendingUp, Megaphone, Workflow, Sparkles } from "lucide-react";
import { clearAdminKey } from "../../lib/admin-key";
import { adminPath } from "../../lib/route-base";
import { AppShell, type NavItem } from "../shell/app-shell";

function navMatch(subpath: string, tail: string): RegExp {
  const base = adminPath(subpath);
  return new RegExp("^" + base + tail + "$");
}

// Grouped 2026-08-27 (design unification) — UI-DESIGN-BRIEF.md had long named "group the flat
// 18-item admin nav into Ops/Compliance/Accounts/Config" as a pending recommendation, never done.
// Order within each group is unchanged from the old flat list; only the grouping is new.
const NAV: NavItem[] = [
  { href: adminPath(), label: "Calls", icon: PhoneCall, match: navMatch("", "(/calls/.*)?"), group: "Ops" },
  { href: adminPath("/demo-calls"), label: "Demo Calls", icon: Sparkles, match: navMatch("/demo-calls", ""), group: "Ops" },
  { href: adminPath("/agents"), label: "Agents", icon: Bot, match: navMatch("/agents", ""), group: "Ops" },
  { href: adminPath("/analytics"), label: "Analytics", icon: BarChart3, match: navMatch("/analytics", ""), group: "Ops" },
  { href: adminPath("/workflows"), label: "Workflows", icon: Workflow, match: navMatch("/workflows", "/workflow-runs"), group: "Ops" },

  { href: adminPath("/compliance"), label: "Compliance", icon: ShieldCheck, match: navMatch("/compliance", ""), group: "Compliance" },
  { href: adminPath("/dnc"), label: "Do Not Call", icon: ShieldOff, match: navMatch("/dnc", ""), group: "Compliance" },

  { href: adminPath("/orgs"), label: "Orgs", icon: Building2, match: navMatch("/orgs", ""), group: "Accounts" },
  { href: adminPath("/users"), label: "Users", icon: Users, match: navMatch("/users", ""), group: "Accounts" },
  { href: adminPath("/waitlist"), label: "Waitlist", icon: ListChecks, match: navMatch("/waitlist", ""), group: "Accounts" },
  { href: adminPath("/billing"), label: "Billing", icon: CreditCard, match: navMatch("/billing", ""), group: "Accounts" },
  { href: adminPath("/revenue-analytics"), label: "Revenue", icon: TrendingUp, match: navMatch("/revenue-analytics", ""), group: "Accounts" },
  { href: adminPath("/marketing-analytics"), label: "Marketing", icon: Megaphone, match: navMatch("/marketing-analytics", ""), group: "Accounts" },

  { href: adminPath("/templates"), label: "Templates", icon: ScrollText, match: navMatch("/templates", ""), group: "Config" },
  { href: adminPath("/flags"), label: "Flags", icon: Shield, match: navMatch("/flags", ""), group: "Config" },
  { href: adminPath("/broadcasts"), label: "Broadcasts", icon: Send, match: navMatch("/broadcasts", ""), group: "Config" },
  { href: adminPath("/support"), label: "Support", icon: LifeBuoy, match: navMatch("/support", ""), group: "Config" },
  { href: adminPath("/logs"), label: "Logs", icon: History, match: navMatch("/logs", ""), group: "Config" },
  { href: adminPath("/settings"), label: "Keys", icon: KeyRound, match: navMatch("/settings", ""), group: "Config" },
];

function Brand() {
  return (
    <span className="flex items-baseline gap-1.5">
      {/* font-display, not font-serif. `font-serif` is Tailwind's STOCK stack
          (ui-serif, Georgia, Cambria, "Times New Roman", Times, serif) — no
          webfont in it, so it never renders the brand typeface at all.
          `font-display` is the theme token for "Bricolage Grotesque Variable"
          (styles.css @theme) — the one shared display face across marketing,
          /app, and /dashboard as of the 2026-08-27 design unification. */}
      <span className="font-display text-lg font-medium tracking-tight">Weeber</span>
      <span className="text-[10px] font-mono uppercase tracking-wider text-sidebar-foreground/60">admin</span>
    </span>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      density="dense"
      collapsible
      nav={NAV}
      brand={<Brand />}
      footer={
        <button
          type="button"
          onClick={() => {
            clearAdminKey();
            window.location.reload();
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-xs text-sidebar-foreground/70 transition-colors duration-150 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        >
          <Lock className="size-3.5" aria-hidden />
          Lock
        </button>
      }
    >
      {children}
    </AppShell>
  );
}
