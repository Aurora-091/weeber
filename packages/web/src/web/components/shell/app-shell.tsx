import { useState, useEffect, createContext, useContext } from "react";
import { Link, useLocation } from "wouter";
import { Menu, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { useTheme } from "../../lib/theme";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "../ui/sheet";
import { Toaster } from "../ui/sonner";
import { CommandPalette, type PaletteAction } from "./command-palette";
import { ThemeToggle } from "./theme-toggle";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: RegExp;
};

type AppShellProps = {
  density: "dense" | "spacious";
  nav: NavItem[];
  brand: React.ReactNode;
  banner?: React.ReactNode;
  footer?: React.ReactNode;
  actions?: PaletteAction[];
  collapsible?: boolean;
  children: React.ReactNode;
};

const STORAGE_KEY = "weeber_sidebar_collapsed";

const SidebarContext = createContext<{ collapsed: boolean; toggle: () => void }>({ collapsed: false, toggle: () => {} });
export function useSidebar() { return useContext(SidebarContext); }

function NavLinks({ nav, collapsed, onNavigate }: { nav: NavItem[]; collapsed?: boolean; onNavigate?: () => void }) {
  const [location] = useLocation();
  return (
    <nav className="flex flex-col gap-0.5 px-2" aria-label="Primary">
      {nav.map(({ href, label, icon: Icon, match }) => {
        const active = match ? match.test(location) : location === href;
        const link = (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center rounded-md text-sm font-medium transition-colors duration-150",
              collapsed ? "justify-center px-2 py-2" : "gap-2.5 px-2.5 py-1.5",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {!collapsed && label}
          </Link>
        );

        if (collapsed) {
          return (
            <Tooltip key={href} delayDuration={0}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right" className="text-xs">{label}</TooltipContent>
            </Tooltip>
          );
        }
        return link;
      })}
    </nav>
  );
}

function SidebarBody({
  nav,
  brand,
  footer,
  collapsed,
  collapsible,
  onToggle,
  onNavigate,
}: {
  nav: NavItem[];
  brand: React.ReactNode;
  footer?: React.ReactNode;
  collapsed?: boolean;
  collapsible?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className={cn("flex h-14 items-center", collapsed ? "justify-center px-2" : "px-4")}>
        {!collapsed && brand}
        {collapsed && <span className="font-serif text-lg font-bold">W</span>}
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        <NavLinks nav={nav} collapsed={collapsed} onNavigate={onNavigate} />
      </div>
      <div className={cn(
        "border-t border-sidebar-border py-2 flex items-center",
        collapsed ? "flex-col gap-1.5 px-1" : "justify-between gap-2 px-2",
      )}>
        <div className="flex items-center gap-1">
          <ThemeToggle />
        </div>
        {!collapsed && footer}
        {collapsible && (
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="rounded-md p-1.5 text-sidebar-foreground/50 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
          >
            {collapsed ? <ChevronsRight className="size-3.5" /> : <ChevronsLeft className="size-3.5" />}
          </button>
        )}
      </div>
    </>
  );
}

export function AppShell({ density, nav, brand, banner, footer, actions, collapsible = false, children }: AppShellProps) {
  const { theme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();
  const [pageKey, setPageKey] = useState(location);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (!collapsible) return false;
    try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
  });

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
      return next;
    });
  }

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
    <SidebarContext.Provider value={{ collapsed: collapsible && collapsed, toggle: toggleCollapsed }}>
      <TooltipProvider>
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
            <aside
              className={cn(
                "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex transition-[width] duration-200",
                collapsible && collapsed ? "w-14" : "w-56",
              )}
            >
              <SidebarBody
                nav={nav}
                brand={brand}
                footer={footer}
                collapsed={collapsible && collapsed}
                collapsible={collapsible}
                onToggle={toggleCollapsed}
              />
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
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}
