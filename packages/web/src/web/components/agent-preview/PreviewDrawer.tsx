import { useState } from "react";
import { Play, Loader as Loader2, Sparkles, Phone, PhoneOff, Mic, PhoneCall } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { AgentTestChat } from "../agent-test-chat";
import { VoiceOrb } from "./VoiceOrb";
import { useVoiceTestCall } from "../../hooks/useVoiceTestCall";

type PreviewDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateName: string;
  /** POSTs { messages, configOverride } — same contract on both admin/user routes. */
  chatFetchFn: (messages: { role: string; content: string }[]) => Promise<Response>;
  /** POSTs { configOverride } to the test-call-token route (same override
   * contract as chatFetchFn) — issues the short-lived token useVoiceTestCall
   * needs to open the live voice WS. See voice/test-call-tokens.ts. */
  testCallTokenFetchFn: () => Promise<Response>;
  /** Reuses each page's existing playPreview()/previewState/previewUrl (the
   * one-shot TTS "Hear it" logic) rather than duplicating fetch/auth here —
   * the drawer just presents it inside the Voice tab as a quick line-level
   * check, alongside the real full-duplex test call. */
  previewState: "idle" | "loading" | "error";
  previewUrl: string | null;
  onPlayPreview: () => void;
  /** Misc-1: POSTs { phone, configOverride } to the test-call-phone route —
   * a real PSTN callback to the merchant's own number, testing this exact
   * in-progress form state. Optional: omit to hide the "call my phone"
   * section entirely (e.g. self-hosted deployments with no telephony set
   * up yet). */
  testCallPhoneFetchFn?: (phone: string) => Promise<Response>;
};

/**
 * Right-side preview drawer — Voice tab now runs a real, backend-wired
 * full-duplex voice test call (AGENT-CONSOLE-UI-PLAN.md Phase 2): mic audio
 * streams to voice/test-call-stream.ts over a WebSocket and hits the actual
 * STT -> LLM -> TTS pipeline (same code path a live call uses), agent audio
 * streams back and plays in the browser. Text tab is the existing test-chat
 * sandbox.
 */
export function PreviewDrawer({
  open,
  onOpenChange,
  templateName,
  chatFetchFn,
  testCallTokenFetchFn,
  previewState,
  previewUrl,
  onPlayPreview,
  testCallPhoneFetchFn,
}: PreviewDrawerProps) {
  const call = useVoiceTestCall(testCallTokenFetchFn);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneCallState, setPhoneCallState] = useState<"idle" | "loading" | "error" | "sent">("idle");
  const [phoneCallError, setPhoneCallError] = useState<string | null>(null);

  async function startPhoneCallback() {
    if (!testCallPhoneFetchFn) return;
    setPhoneCallState("loading");
    setPhoneCallError(null);
    try {
      const res = await testCallPhoneFetchFn(phoneNumber.trim());
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Call failed (${res.status})`);
      setPhoneCallState("sent");
    } catch (err) {
      setPhoneCallState("error");
      setPhoneCallError(err instanceof Error ? err.message : "Call failed");
    }
  }

  const orbState =
    call.status === "connecting"
      ? "thinking"
      : call.status === "speaking"
        ? "speaking"
        : call.status === "listening"
          ? "listening"
          : "idle";
  const orbLevel = call.status === "speaking" ? call.agentLevel : call.status === "listening" ? call.micLevel : 0;

  const callActive = call.status === "connecting" || call.status === "listening" || call.status === "speaking";

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && callActive) call.stop();
        onOpenChange(next);
      }}
    >
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
            <VoiceOrb state={orbState} level={orbLevel} />

            {callActive ? (
              <button
                type="button"
                onClick={() => call.stop()}
                className="inline-flex items-center gap-2 rounded-md bg-destructive text-destructive-foreground px-4 py-2 text-sm font-medium hover:bg-destructive/90 transition-colors"
              >
                <PhoneOff className="size-4" aria-hidden />
                End test call
              </button>
            ) : (
              <button
                type="button"
                onClick={() => call.start()}
                className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                <Phone className="size-4" aria-hidden />
                Start test call
              </button>
            )}

            <p className="text-xs text-muted-foreground text-center max-w-xs">
              {call.status === "connecting" && "Connecting — allow microphone access if prompted…"}
              {call.status === "listening" && "Listening — talk to the agent like a real call."}
              {call.status === "speaking" && "Agent is speaking…"}
              {call.status === "idle" && "A real back-and-forth call with this agent's exact config, right in your browser."}
              {call.status === "ended" && "Call ended."}
              {call.status === "error" && (call.errorMessage ?? "Test call failed.")}
            </p>

            {call.transcripts.length > 0 && (
              <div className="w-full max-h-40 overflow-y-auto rounded-md border border-border bg-background/60 p-2 text-xs space-y-1">
                {call.transcripts.map((entry, i) => (
                  <p key={i}>
                    <span className="font-medium">{entry.role === "caller" ? "You" : "Agent"}:</span>{" "}
                    {entry.text}
                  </p>
                ))}
              </div>
            )}

            <div className="w-full border-t border-border pt-4 flex flex-col items-center gap-3">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Mic className="size-3" aria-hidden />
                Or just hear one line in this voice, no mic needed
              </p>
              <button
                type="button"
                onClick={onPlayPreview}
                disabled={previewState === "loading"}
                className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
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
                  controls
                  autoPlay
                  src={previewUrl}
                  className="h-9 w-full"
                  aria-label="Voice preview playback"
                >
                  <track kind="captions" />
                </audio>
              )}
            </div>

            {testCallPhoneFetchFn && (
              <div className="w-full border-t border-border pt-4 flex flex-col items-center gap-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <PhoneCall className="size-3" aria-hidden />
                  Or get a real call on your phone — actual telephony cost applies
                </p>
                <div className="flex w-full gap-2">
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="+15551234567"
                    disabled={phoneCallState === "loading"}
                    className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={startPhoneCallback}
                    disabled={phoneCallState === "loading" || !phoneNumber.trim()}
                    className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50 whitespace-nowrap"
                  >
                    {phoneCallState === "loading" ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <PhoneCall className="size-4" aria-hidden />
                    )}
                    Call me
                  </button>
                </div>
                {phoneCallState === "sent" && (
                  <p className="text-xs text-success text-center">Calling now — pick up in a few seconds.</p>
                )}
                {phoneCallState === "error" && (
                  <p className="text-xs text-destructive text-center">{phoneCallError}</p>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="text" className="flex-1 flex flex-col pt-4">
            <AgentTestChat fetchFn={chatFetchFn} templateName={templateName} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
