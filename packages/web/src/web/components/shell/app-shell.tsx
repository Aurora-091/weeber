import { useState, useCallback, createContext, useContext } from "react";
import { Link, useLocation } from "wouter";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { useTheme } from "../../lib/theme";
import { PortalContainerContext } from "../../lib/portal-container";
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
  /** Opts this page out of the standard max-width/padded page container —
   * for pages that need the full remaining viewport (e.g. a canvas or a
   * full-window agent console), not the default article-width reading
   * layout every other page uses. */
  fullBleed?: boolean;
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

  const linkEl = (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md text-sm font-medium outline-none",
        "transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        collapsed ? "h-9 w-9 justify-center px-0" : "px-3 py-2",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
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
      <Icon className="size-[15px] shrink-0" aria-hidden />
      {/* Label fades out when collapsing */}
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
      className={cn("flex flex-col gap-0.5 py-1", collapsed ? "px-1.5" : "px-2")}
      aria-label="Primary"
    >
      {nav.map((item) => (
        <NavLink key={item.href} {...item} collapsed={collapsed} onClick={onNavigate} />
      ))}
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
      <div className="flex-1 overflow-y-auto py-2">
        <NavLinks nav={nav} collapsed={collapsed} onNavigate={onNavigate} />
      </div>

      {/* Footer row */}
      <div
        className={cn(
          "flex shrink-0 items-center border-t border-sidebar-border py-2",
          collapsed ? "flex-col gap-1.5 px-1.5" : "gap-2 px-3",
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
  fullBleed = false,
  children,
}: AppShellProps) {
  const { theme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

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
  // useCallback ref fires synchronously when the node mounts, so the state is
  // set before any child portals (Dialog/Sheet/Dropdown/Tooltip) attempt to
  // resolve their container. A plain useState(null) ref leaves portals falling
  // back to document.body on the first render.
  const shellRef = useCallback((node: HTMLDivElement | null) => {
    if (node) setPortalContainer(node);
  }, []);

  return (
    <SidebarContext.Provider value={{ collapsed: activeCollapsed, toggle: toggleCollapsed }}>
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
          <Toaster position="bottom-right" />
          <div className="flex min-h-screen">
            {/* Desktop sidebar */}
            <aside
              className={cn(
                "sticky top-0 hidden h-screen shrink-0 flex-col md:flex",
                "bg-sidebar text-sidebar-foreground",
                "border-r border-sidebar-border",
                "transition-[width] duration-200 ease-out shadow-weeber-sidebar",
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

            {/* Content area */}
            <div className="min-w-0 flex-1">
              {/* Mobile topbar */}
              <div className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur-sm md:hidden">
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
                    className="flex w-60 flex-col bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden shadow-weeber-elevated"
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

              <main
                className={cn("w-full", fullBleed ? "h-[calc(100vh-3rem)] md:h-screen" : "mx-auto")}
                style={
                  fullBleed
                    ? undefined
                    : {
                        maxWidth: "var(--shell-page-max-w)",
                        padding: "var(--shell-page-py) var(--shell-page-px)",
                      }
                }
              >
                <div
                  className={cn(fullBleed && "h-full")}
                >
                  {children}
                </div>
              </main>
            </div>
          </div>
          </PortalContainerContext.Provider>
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}
