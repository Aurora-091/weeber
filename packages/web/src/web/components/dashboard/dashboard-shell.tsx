import { Link, useLocation } from "wouter";
import { motion } from "motion/react";
import { PhoneCall, ShieldOff, ShieldCheck, KeyRound, ArrowLeft, Bot, BarChart3 } from "lucide-react";
import { clearAdminKey } from "../../lib/admin-key";

const NAV = [
  { href: "/dashboard", label: "Calls", icon: PhoneCall, match: /^\/dashboard(\/calls\/.*)?$/ },
  { href: "/dashboard/agents", label: "Agents", icon: Bot, match: /^\/dashboard\/agents$/ },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3, match: /^\/dashboard\/analytics$/ },
  { href: "/dashboard/dnc", label: "Do Not Call", icon: ShieldOff, match: /^\/dashboard\/dnc$/ },
  { href: "/dashboard/audit", label: "Audit", icon: ShieldCheck, match: /^\/dashboard\/audit$/ },
  { href: "/dashboard/settings", label: "Keys", icon: KeyRound, match: /^\/dashboard\/settings$/ },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-border bg-paper/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-1.5 text-ink-soft hover:text-ink transition-colors text-sm">
              <ArrowLeft className="size-3.5" />
              <img src="/logo-mark.png" alt="" className="size-4" />
              OpenVent
            </Link>
            <nav className="flex items-center gap-1">
              {NAV.map(({ href, label, icon: Icon, match }) => {
                const active = match.test(location);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      active ? "bg-ember/10 text-ember" : "text-ink-soft hover:text-ink hover:bg-paper-2"
                    }`}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <button
            onClick={() => {
              clearAdminKey();
              window.location.reload();
            }}
            className="text-xs font-mono text-ink-soft hover:text-ink transition-colors"
          >
            Lock
          </button>
        </div>
      </header>
      <motion.main
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="max-w-6xl mx-auto px-6 py-10"
      >
        {children}
      </motion.main>
    </div>
  );
}
