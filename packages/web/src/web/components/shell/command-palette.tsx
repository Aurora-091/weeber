import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import type { LucideIcon } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import type { NavItem } from "./app-shell";

export type PaletteAction = {
  label: string;
  run: () => void;
  icon?: LucideIcon;
};

export function CommandPalette({ nav, actions }: { nav: NavItem[]; actions?: PaletteAction[] }) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Jump to a page or run an action">
      <CommandInput placeholder="Where to?" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Pages">
          {nav.map(({ href, label, icon: Icon }) => (
            <CommandItem
              key={href}
              onSelect={() => {
                setOpen(false);
                navigate(href);
              }}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </CommandItem>
          ))}
        </CommandGroup>
        {actions && actions.length > 0 && (
          <CommandGroup heading="Actions">
            {actions.map(({ label, run, icon: Icon }) => (
              <CommandItem
                key={label}
                onSelect={() => {
                  setOpen(false);
                  run();
                }}
              >
                {Icon && <Icon className="size-4" aria-hidden />}
                {label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
