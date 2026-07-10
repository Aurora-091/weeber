import {
  PhoneCall,
  ShieldOff,
  ShieldCheck,
  KeyRound,
  Bot,
  BarChart3,
  Lock,
  Users,
  Building2,
  CreditCard,
  Shield,
  ScrollText,
  ListChecks,
  Send,
  LifeBuoy,
  History,
  TrendingUp,
  Megaphone,
} from "lucide-react";
import { clearAdminKey } from "../../lib/admin-key";
import { AppShell, type NavItem } from "../shell/app-shell";

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Calls", icon: PhoneCall, match: /^\/dashboard(\/calls\/.*)?$/ },
  { href: "/dashboard/agents", label: "Agents", icon: Bot, match: /^\/dashboard\/agents$/ },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3, match: /^\/dashboard\/analytics$/ },
  { href: "/dashboard/orgs", label: "Orgs", icon: Building2, match: /^\/dashboard\/orgs$/ },
  { href: "/dashboard/users", label: "Users", icon: Users, match: /^\/dashboard\/users$/ },
  { href: "/dashboard/waitlist", label: "Waitlist", icon: ListChecks, match: /^\/dashboard\/waitlist$/ },
  { href: "/dashboard/broadcasts", label: "Broadcasts", icon: Send, match: /^\/dashboard\/broadcasts$/ },
  { href: "/dashboard/templates", label: "Templates", icon: ScrollText, match: /^\/dashboard\/templates$/ },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard, match: /^\/dashboard\/billing$/ },
  { href: "/dashboard/revenue-analytics", label: "Revenue", icon: TrendingUp, match: /^\/dashboard\/revenue-analytics$/ },
  { href: "/dashboard/marketing-analytics", label: "Marketing", icon: Megaphone, match: /^\/dashboard\/marketing-analytics$/ },
  { href: "/dashboard/compliance", label: "Compliance", icon: ShieldCheck, match: /^\/dashboard\/compliance$/ },
  { href: "/dashboard/flags", label: "Flags", icon: Shield, match: /^\/dashboard\/flags$/ },
  { href: "/dashboard/dnc", label: "Do Not Call", icon: ShieldOff, match: /^\/dashboard\/dnc$/ },
  { href: "/dashboard/support", label: "Support", icon: LifeBuoy, match: /^\/dashboard\/support$/ },
  { href: "/dashboard/logs", label: "Logs", icon: History, match: /^\/dashboard\/logs$/ },
  { href: "/dashboard/settings", label: "Keys", icon: KeyRound, match: /^\/dashboard\/settings$/ },
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
