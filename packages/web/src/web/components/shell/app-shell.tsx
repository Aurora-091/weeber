import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Menu } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { useTheme } from "../../lib/theme";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "../ui/sheet";
import { Toaster } from "../ui/sonner";
import { CommandPalette, type PaletteAction } from "./command-palette";
import { ThemeToggle } from "./theme-toggle";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Active when this matches the current location; falls back to exact href match. */
  match?: RegExp;
};

type AppShellProps = {
  /** dense = admin panel (/dashboard), spacious = user app (/app) */
  density: "dense" | "spacious";
  nav: NavItem[];
  brand: React.ReactNode;
  /** Rendered above the page content, full-width (e.g. a status/warning banner). */
  banner?: React.ReactNode;
  /** Rendered at the bottom of the sidebar (e.g. Lock / sign-out button). */
  footer?: React.ReactNode;
  /** Extra command-palette actions beyond page navigation. */
  actions?: PaletteAction[];
  children: React.ReactNode;
};

function NavLinks({ nav, onNavigate }: { nav: NavItem[]; onNavigate?: () => void }) {
  const [location] = useLocation();
  return (
    <nav className="flex flex-col gap-0.5 px-2" aria-label="Primary">
      {nav.map(({ href, label, icon: Icon, match }) => {
        const active = match ? match.test(location) : location === href;
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-150",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarBody({
  nav,
  brand,
  footer,
  onNavigate,
}: {
  nav: NavItem[];
  brand: React.ReactNode;
  footer?: React.ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="flex h-14 items-center px-4">{brand}</div>
      <div className="flex-1 overflow-y-auto py-2">
        <NavLinks nav={nav} onNavigate={onNavigate} />
      </div>
      <div className="border-t border-sidebar-border px-2 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <ThemeToggle />
        </div>
        {footer}
      </div>
    </>
  );
}

export function AppShell({ density, nav, brand, banner, footer, actions, children }: AppShellProps) {
  const { theme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();
  const [pageKey, setPageKey] = useState(location);
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    if (location !== pageKey) {
      setIsTransitioning(true);
      const timer = setTimeout(() => {
        setPageKey(location);
        setIsTransitioning(false);
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [location, pageKey]);

  return (
    <div
      className={cn(
        "theme-weeber min-h-screen bg-background text-foreground font-sans",
        theme === "dark" && "dark",
        density === "dense" ? "shell-dense" : "shell-spacious",
      )}
    >
      <CommandPalette nav={nav} actions={actions} />
      <Toaster position="bottom-right" />
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
          <SidebarBody nav={nav} brand={brand} footer={footer} />
        </aside>
        <div className="min-w-0 flex-1">
          <div className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur md:hidden">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <button
                  type="button"
                  aria-label="Open navigation"
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Menu className="size-5" aria-hidden />
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="flex w-64 flex-col bg-sidebar p-0 text-sidebar-foreground">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <SidebarBody nav={nav} brand={brand} footer={footer} onNavigate={() => setMobileOpen(false)} />
              </SheetContent>
            </Sheet>
            {brand}
          </div>
          {banner}
          <main
            className="mx-auto w-full"
            style={{
              maxWidth: "var(--shell-page-max-w)",
              padding: "var(--shell-page-py) var(--shell-page-px)",
            }}
          >
            <div
              key={pageKey}
              className={cn(
                "page-enter",
                isTransitioning && "opacity-0",
              )}
            >
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
