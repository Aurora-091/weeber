import { useState, useCallback, useEffect, createContext, useContext } from "react";
import { Link, useLocation } from "wouter";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { prefetchRoute } from "../../lib/route-prefetch";
import { useTheme } from "../../lib/theme";
import { PortalContainerContext } from "../../lib/portal-container";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "../ui/sheet";
import { Toaster } from "../ui/sonner";
import { CommandPalette, type PaletteAction } from "./command-palette";
import { KeyboardShortcuts } from "./keyboard-shortcuts";
import { ThemeToggle } from "./theme-toggle";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: RegExp;
  /** Optional section label (2026-08-27 design unification — UI-DESIGN-BRIEF.md had long named
   * "group the flat 18-item admin nav into Ops/Compliance/Accounts/Config" as a pending
   * recommendation). Items sharing the same `group`, adjacent in the array, render under one
   * label. Ungrouped items (no `group` set) render with no header, same as before — this is
   * additive, existing callers (UserShell's vertical-aware nav) are unaffected. */
  group?: string;
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

const SidebarContext = createContext<{ collapsed: boolean; toggle: () => void }>({
  collapsed: false,
  toggle: () => {},
});
export function useSidebar() {
  return useContext(SidebarContext);
}

/**
 * Per-page opt-in to a full-bleed content area. The shell stays mounted while
 * inner pages swap, so a page that needs the whole viewport (workflow canvas)
 * flips this on mount and back off on unmount — every other page keeps the
 * default centered, padded, max-width <main> (natural document scroll, sticky
 * headers intact). See useShellFullBleed().
 */
const ShellLayoutContext = createContext<{ setFullBleed: (v: boolean) => void }>({
  setFullBleed: () => {},
});

/** Call from a page component to make the shell's <main> fill the viewport
 * edge-to-edge (no max-width, no padding, no document scroll) for as long as
 * that page is mounted. */
export function useShellFullBleed() {
  const { setFullBleed } = useContext(ShellLayoutContext);
  useEffect(() => {
    setFullBleed(true);
    return () => setFullBleed(false);
  }, [setFullBleed]);
}

function NavLink({
  href,
  label,
  icon: Icon,
  match,
  collapsed,
  onClick,
}: NavItem & { collapsed?: boolean; onClick?: () => void }) {
  const [location] = useLocation();
  const active = match ? match.test(location) : location === href;

  // Warm the target page's lazy chunk on nav intent so clicking swaps
  // content instantly instead of flashing PageFallback while the chunk
  // downloads (see lib/route-prefetch.ts). Best-effort, fires at most once.
  const warm = () => prefetchRoute(href);

  const linkEl = (
    <Link
      href={href}
      onClick={onClick}
      onMouseEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-md text-sm font-medium outline-none",
        "transition-[background-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        collapsed ? "h-9 w-9 justify-center px-0" : "px-3 py-2.5",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
          : "text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      {/* Active left-accent bar */}
      <span
        className={cn(
          "absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-sidebar-primary",
          "transition-all duration-200",
          active ? "h-5 opacity-100" : "h-0 opacity-0",
        )}
        aria-hidden
      />
      <Icon className="size-4 shrink-0" aria-hidden />
      <span
        className={cn(
          "truncate transition-[opacity,transform] duration-200",
          collapsed ? "pointer-events-none w-0 translate-x-1 opacity-0" : "opacity-100 translate-x-0",
        )}
      >
        {label}
      </span>
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{linkEl}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={6} className="text-xs font-medium">
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }
  return linkEl;
}

function NavLinks({
  nav,
  collapsed,
  onNavigate,
}: {
  nav: NavItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav
      className={cn("flex flex-col gap-1.5 py-2", collapsed ? "px-1.5" : "px-2.5")}
      aria-label="Primary"
    >
      {nav.map((item, i) => {
        const showGroupLabel = !collapsed && item.group && item.group !== nav[i - 1]?.group;
        return (
          <div key={item.href}>
            {showGroupLabel && (
              <div
                className={cn(
                  "px-2.5 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50",
                  i === 0 ? "mb-1.5" : "mb-1.5 mt-3",
                )}
              >
                {item.group}
              </div>
            )}
            <NavLink {...item} collapsed={collapsed} onClick={onNavigate} />
          </div>
        );
      })}
    </nav>
  );
}

function SidebarCollapseButton({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
        "text-sidebar-foreground/40 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        "transition-colors duration-150",
      )}
    >
      {collapsed ? (
        <PanelLeftOpen className="size-3.5" aria-hidden />
      ) : (
        <PanelLeftClose className="size-3.5" aria-hidden />
      )}
    </button>
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
    <div className="flex h-full flex-col">
      {/* Brand row */}
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-sidebar-border",
          collapsed ? "justify-center px-2" : "justify-between px-4",
        )}
      >
        <div
          className={cn(
            "overflow-hidden transition-[width,opacity] duration-200",
            collapsed ? "w-0 opacity-0" : "min-w-0 flex-1 opacity-100",
          )}
        >
          {brand}
        </div>
        {collapsed && (
          <span className="font-display text-base font-semibold text-sidebar-foreground select-none">
            W
          </span>
        )}
        {collapsible && !collapsed && (
          <SidebarCollapseButton collapsed={false} onToggle={onToggle!} />
        )}
      </div>

      {/* Nav items */}
      <div className="flex-1 overflow-y-auto py-3">
        <NavLinks nav={nav} collapsed={collapsed} onNavigate={onNavigate} />
      </div>

      {/* Footer row */}
      <div
        className={cn(
          "flex shrink-0 items-center border-t border-sidebar-border py-3",
          collapsed ? "flex-col gap-2 px-1.5" : "gap-2 px-3",
        )}
      >
        <ThemeToggle />
        {!collapsed && <div className="flex-1 overflow-hidden">{footer}</div>}
        {collapsible && collapsed && (
          <SidebarCollapseButton collapsed onToggle={onToggle!} />
        )}
      </div>
    </div>
  );
}

export function AppShell({
  density,
  nav,
  brand,
  banner,
  footer,
  actions,
  collapsible = false,
  children,
}: AppShellProps) {
  const { theme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [fullBleed, setFullBleed] = useState(false);

  const [collapsed, setCollapsed] = useState(() => {
    if (!collapsible) return false;
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  }

  const activeCollapsed = collapsible && collapsed;

  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const shellRef = useCallback((node: HTMLDivElement | null) => {
    if (node) setPortalContainer(node);
  }, []);

  return (
    <SidebarContext.Provider value={{ collapsed: activeCollapsed, toggle: toggleCollapsed }}>
      <ShellLayoutContext.Provider value={{ setFullBleed }}>
      <TooltipProvider>
        <div
          ref={shellRef}
          className={cn(
            "theme-weeber min-h-screen bg-background text-foreground font-sans",
            theme === "dark" && "dark",
            density === "dense" ? "shell-dense" : "shell-spacious",
          )}
        >
          <PortalContainerContext.Provider value={portalContainer}>
          <CommandPalette nav={nav} actions={actions} />
          <KeyboardShortcuts />
          <Toaster position="bottom-right" />
          <div className="flex min-h-screen">
            {/* Desktop sidebar */}
            <aside
              className={cn(
                "sticky top-0 z-20 hidden h-screen shrink-0 flex-col md:flex",
                "bg-sidebar text-sidebar-foreground",
                "rounded-r-2xl border-r border-sidebar-border",
                // Same spring-like easing as .page-enter/.content-fade-in
                // (cubic-bezier(0.16,1,0.3,1)) — the collapse/expand used a
                // plain ease-out before, a subtly different motion feel from
                // every other animated surface in the app.
                "transition-[width] duration-200 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] shadow-weeber-sidebar",
                activeCollapsed ? "w-[3.25rem]" : "w-56",
              )}
            >
              <SidebarBody
                nav={nav}
                brand={brand}
                footer={footer}
                collapsed={activeCollapsed}
                collapsible={collapsible}
                onToggle={toggleCollapsed}
              />
            </aside>

            {/* Content area — becomes a fixed-height flex column only in
                full-bleed mode so a canvas page can fill the viewport; every
                other page keeps natural document flow/scroll. */}
            <div className={cn("min-w-0 flex-1", fullBleed && "flex h-[100dvh] flex-col overflow-hidden")}>
              {/* Mobile topbar — z-30 so it clears sticky page headers
                  (z-10) and the desktop sidebar's z-20 when the viewport
                  transitions across the md breakpoint mid-session, while
                  still sitting well below dialog/sheet overlays at
                  z-50. */}
              <div className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur-sm md:hidden">
                <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                  <SheetTrigger asChild>
                    <button
                      type="button"
                      aria-label="Open navigation"
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    >
                      <Menu className="size-5" aria-hidden />
                    </button>
                  </SheetTrigger>
                  <SheetContent
                    side="left"
                    className="flex w-64 flex-col bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden shadow-weeber-elevated"
                  >
                    <SheetTitle className="sr-only">Navigation</SheetTitle>
                    <SidebarBody
                      nav={nav}
                      brand={brand}
                      footer={footer}
                      onNavigate={() => setMobileOpen(false)}
                    />
                  </SheetContent>
                </Sheet>
                {brand}
              </div>

              {banner}

              {fullBleed ? (
                <main className="@container min-h-0 w-full flex-1 overflow-hidden">{children}</main>
              ) : (
                <main
                  className="@container mx-auto w-full"
                  style={{
                    maxWidth: "var(--shell-page-max-w)",
                    padding: "var(--shell-page-py) var(--shell-page-px)",
                  }}
                >
                  {children}
                </main>
              )}
            </div>
          </div>
          </PortalContainerContext.Provider>
        </div>
      </TooltipProvider>
      </ShellLayoutContext.Provider>
    </SidebarContext.Provider>
  );
}
