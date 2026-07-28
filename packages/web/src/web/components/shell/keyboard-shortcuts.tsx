import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

/** Detect Mac so we render "⌘K" on macOS and "Ctrl K" everywhere else — the
 * command palette uses metaKey || ctrlKey, so both work; this is display-only. */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-muted px-1.5 font-mono text-[11px] font-medium text-foreground shadow-[inset_0_-1px_0_var(--color-border)]">
      {children}
    </kbd>
  );
}

function Row({ keys, label }: { keys: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-foreground">{label}</span>
      <span className="flex items-center gap-1">{keys}</span>
    </div>
  );
}

/** Global "?" cheat sheet. Ignores keydowns from inputs/textareas/contenteditable
 * so a merchant typing "who was this?" into a search box doesn't open the dialog
 * mid-sentence. */
export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);
  const mac = isMac();
  const mod = mac ? "⌘" : "Ctrl";

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (target as HTMLElement | null)?.isContentEditable;
      if (inEditable) return;
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="size-4 text-muted-foreground" aria-hidden />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Move around Weeber without touching the mouse.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 divide-y divide-border">
          <div className="pb-2">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Global
            </div>
            <Row
              label="Open the command palette"
              keys={
                <>
                  <Key>{mod}</Key>
                  <span className="text-xs text-muted-foreground">+</span>
                  <Key>K</Key>
                </>
              }
            />
            <Row label="Show these shortcuts" keys={<Key>?</Key>} />
            <Row label="Close a dialog or drawer" keys={<Key>Esc</Key>} />
          </div>
          <div className="pt-2 pb-2">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              In the command palette
            </div>
            <Row
              label="Move between results"
              keys={
                <>
                  <Key>↑</Key>
                  <Key>↓</Key>
                </>
              }
            />
            <Row label="Jump to the selected result" keys={<Key>Enter</Key>} />
          </div>
          <div className="pt-2">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Forms
            </div>
            <Row
              label="Save changes"
              keys={
                <>
                  <Key>{mod}</Key>
                  <span className="text-xs text-muted-foreground">+</span>
                  <Key>S</Key>
                </>
              }
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
