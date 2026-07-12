import { useRef, useState } from "react";
import { Play, Loader as Loader2, Sparkles } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { AgentTestChat } from "../agent-test-chat";
import { VoiceOrb } from "./VoiceOrb";
import { useAudioLevel } from "../../hooks/useAudioLevel";

type PreviewDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateName: string;
  /** POSTs { messages, configOverride } — same contract on both admin/merchant routes. */
  chatFetchFn: (messages: { role: string; content: string }[]) => Promise<Response>;
  /** Reuses each page's existing playPreview()/previewState/previewUrl (the
   * one-shot TTS "Hear it" logic) rather than duplicating fetch/auth here —
   * the drawer just presents it inside the Voice tab. */
  previewState: "idle" | "loading" | "error";
  previewUrl: string | null;
  onPlayPreview: () => void;
};

/**
 * Right-side preview drawer — Phase 1 of AGENT-CONSOLE-UI-PLAN.md. Two tabs:
 * Voice (orb reacting to the existing one-shot TTS preview audio) and Text
 * (the real test-chat sandbox, now sending the in-progress form state as
 * configOverride so this previews what's about to be saved, not just what's
 * already saved — see buildPreviewAgentConfig in voice/agent.ts).
 *
 * Full live mic-in/voice-out call (Phase 2) is a separate, larger backend
 * lift (a new WS transport provider) — not built here.
 */
export function PreviewDrawer({
  open,
  onOpenChange,
  templateName,
  chatFetchFn,
  previewState,
  previewUrl,
  onPlayPreview,
}: PreviewDrawerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const level = useAudioLevel(audioEl);
  const orbState = previewState === "loading" ? "thinking" : level > 0.05 ? "speaking" : "idle";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Preview — {templateName}
          </SheetTitle>
          <SheetDescription>
            Tests your current, unsaved edits — not what's already saved.
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="voice" className="flex-1 flex flex-col px-4 pb-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="voice">Voice</TabsTrigger>
            <TabsTrigger value="text">Text</TabsTrigger>
          </TabsList>

          <TabsContent value="voice" className="flex-1 flex flex-col items-center justify-center gap-6 pt-6">
            <VoiceOrb state={orbState} level={level} />
            <button
              type="button"
              onClick={onPlayPreview}
              disabled={previewState === "loading"}
              className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {previewState === "loading" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Play className="size-4" aria-hidden />
              )}
              Hear this agent
            </button>
            {previewState === "error" && (
              <p className="text-xs text-destructive text-center">Preview failed — try a different voice, or try again in a minute.</p>
            )}
            {previewUrl && (
              <audio
                ref={(el) => {
                  audioRef.current = el;
                  if (el && el !== audioEl) setAudioEl(el);
                }}
                controls
                autoPlay
                src={previewUrl}
                className="h-9 w-full"
                aria-label="Voice preview playback"
              >
                <track kind="captions" />
              </audio>
            )}
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              Plays one line in the agent's currently-selected voice. For a real back-and-forth
              conversation, use the Text tab — a full live voice test call is coming in a later round.
            </p>
          </TabsContent>

          <TabsContent value="text" className="flex-1 flex flex-col pt-4">
            <AgentTestChat fetchFn={chatFetchFn} templateName={templateName} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
