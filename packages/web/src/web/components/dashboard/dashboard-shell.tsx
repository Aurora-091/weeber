import { PhoneCall, ShieldOff, ShieldCheck, KeyRound, Bot, ChartBar as BarChart3, Lock, Users, Building2, CreditCard, Shield, ScrollText, ListChecks, Send, LifeBuoy, History, TrendingUp, Megaphone, Workflow } from "lucide-react";
import { clearAdminKey } from "../../lib/admin-key";
import { adminPath } from "../../lib/route-base";
import { AppShell, type NavItem } from "../shell/app-shell";

function navMatch(subpath: string, tail: string): RegExp {
  const base = adminPath(subpath);
  return new RegExp("^" + base + tail + "$");
}

const NAV: NavItem[] = [
  { href: adminPath(), label: "Calls", icon: PhoneCall, match: navMatch("", "(/calls/.*)?") },
  { href: adminPath("/agents"), label: "Agents", icon: Bot, match: navMatch("/agents", "") },
  { href: adminPath("/analytics"), label: "Analytics", icon: BarChart3, match: navMatch("/analytics", "") },
  { href: adminPath("/compliance"), label: "Compliance", icon: ShieldCheck, match: navMatch("/compliance", "") },
  { href: adminPath("/dnc"), label: "Do Not Call", icon: ShieldOff, match: navMatch("/dnc", "") },
  { href: adminPath("/orgs"), label: "Orgs", icon: Building2, match: navMatch("/orgs", "") },
  { href: adminPath("/users"), label: "Users", icon: Users, match: navMatch("/users", "") },
  { href: adminPath("/waitlist"), label: "Waitlist", icon: ListChecks, match: navMatch("/waitlist", "") },
  { href: adminPath("/broadcasts"), label: "Broadcasts", icon: Send, match: navMatch("/broadcasts", "") },
  { href: adminPath("/templates"), label: "Templates", icon: ScrollText, match: navMatch("/templates", "") },
  { href: adminPath("/billing"), label: "Billing", icon: CreditCard, match: navMatch("/billing", "") },
  { href: adminPath("/revenue-analytics"), label: "Revenue", icon: TrendingUp, match: navMatch("/revenue-analytics", "") },
  { href: adminPath("/marketing-analytics"), label: "Marketing", icon: Megaphone, match: navMatch("/marketing-analytics", "") },
  { href: adminPath("/workflow-runs"), label: "Workflows", icon: Workflow, match: navMatch("/workflow-runs", "") },
  { href: adminPath("/flags"), label: "Flags", icon: Shield, match: navMatch("/flags", "") },
  { href: adminPath("/support"), label: "Support", icon: LifeBuoy, match: navMatch("/support", "") },
  { href: adminPath("/logs"), label: "Logs", icon: History, match: navMatch("/logs", "") },
  { href: adminPath("/settings"), label: "Keys", icon: KeyRound, match: navMatch("/settings", "") },
];

function Brand() {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-serif text-lg font-medium tracking-tight">Weeber</span>
      <span className="text-[10px] font-mono uppercase tracking-wider text-sidebar-foreground/60">admin</span>
    </span>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      density="dense"
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
