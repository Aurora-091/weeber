import { cn } from "../../lib/utils";

type OrbState = "idle" | "listening" | "speaking" | "thinking";

/**
 * CSS-only animated orb — no 3D/WebGL library (per AGENT-CONSOLE-UI-PLAN.md
 * §4's "not doing" list, keeps bundle size down). Scale/opacity driven by a
 * live audio level (0-1, from useAudioLevel/useVoiceTestCall) layered on top
 * of a base per-state animation, so it reads as "reacting to sound" rather
 * than a generic looping spinner.
 *
 * Enhanced 2026-07-18 (real audio was already wired via `level` — the orb
 * itself just wasn't visually alive enough while it played): moved from a
 * single scaling circle to a 3-blob morphing cluster + glow, matching the
 * marketing site's demo-widget orb (`AgentDemoWidget.tsx`'s `DemoOrb`) so the
 * in-app preview and the public demo feel like the same product. The organic
 * per-blob morph loop (CSS keyframes) runs independently of the live level;
 * the live level scales the whole cluster on top via inline transform on the
 * wrapper, so real audio reactivity and the always-on organic motion compose
 * without fighting over the same transform.
 */
export function VoiceOrb({ state, level = 0 }: { state: OrbState; level?: number }) {
  const isActive = state === "speaking" || state === "listening";
  const levelScale = 1 + level * 0.22;

  return (
    <div className="relative flex items-center justify-center size-32">
      <div
        className={cn(
          "absolute inset-[-20%] rounded-full blur-2xl transition-opacity duration-300 voice-orb-glow",
          state === "idle" && "opacity-[0.12] bg-primary",
          state === "listening" && "opacity-25 bg-success voice-orb-glow--pulse",
          state === "speaking" && "opacity-30 bg-primary voice-orb-glow--pulse",
          state === "thinking" && "opacity-20 bg-warning voice-orb-glow--pulse",
        )}
      />

      <div
        className={cn(
          "relative size-20 rounded-full overflow-hidden voice-orb-container",
          isActive && "voice-orb-container--active",
        )}
        style={{ transform: isActive ? `scale(${levelScale})` : "scale(1)" }}
      >
        <span
          className={cn(
            "voice-orb-blob voice-orb-blob--1",
            state === "idle" && "bg-primary/50",
            state === "listening" && "bg-success/70 voice-orb-blob--active",
            state === "speaking" && "bg-primary/80 voice-orb-blob--active",
            state === "thinking" && "bg-warning/60 voice-orb-blob--active",
          )}
        />
        <span
          className={cn(
            "voice-orb-blob voice-orb-blob--2",
            state === "idle" && "bg-primary/35",
            state === "listening" && "bg-success/55 voice-orb-blob--active",
            state === "speaking" && "bg-primary/60 voice-orb-blob--active",
            state === "thinking" && "bg-warning/45 voice-orb-blob--active",
          )}
        />
        <span
          className={cn(
            "voice-orb-blob voice-orb-blob--3",
            state === "idle" && "bg-primary/25",
            state === "listening" && "bg-success/45 voice-orb-blob--active",
            state === "speaking" && "bg-primary/45 voice-orb-blob--active",
            state === "thinking" && "bg-warning/35 voice-orb-blob--active",
          )}
        />
      </div>

      <span className="sr-only">
        {state === "idle" && "Agent idle"}
        {state === "listening" && "Listening"}
        {state === "speaking" && "Agent speaking"}
        {state === "thinking" && "Agent thinking"}
      </span>
    </div>
  );
}
