import { cn } from "../../lib/utils";

type OrbState = "idle" | "listening" | "speaking" | "thinking";

/**
 * CSS-only animated orb — no 3D/WebGL library (per AGENT-CONSOLE-UI-PLAN.md
 * §4's "not doing" list, keeps bundle size down). Scale/opacity driven by a
 * live audio level (0-1, from useAudioLevel) layered on top of a base
 * per-state animation, so it reads as "reacting to sound" rather than a
 * generic looping spinner.
 */
export function VoiceOrb({ state, level = 0 }: { state: OrbState; level?: number }) {
  const scale = 1 + level * 0.35;

  return (
    <div className="relative flex items-center justify-center size-32">
      <div
        className={cn(
          "absolute inset-0 rounded-full blur-xl opacity-60 transition-opacity duration-300",
          state === "idle" && "bg-primary/20",
          state === "listening" && "bg-success/30 animate-pulse",
          state === "speaking" && "bg-primary/40",
          state === "thinking" && "bg-warning/30 animate-pulse",
        )}
      />
      <div
        className={cn(
          "relative size-20 rounded-full transition-transform duration-100 ease-out",
          "bg-gradient-to-br from-primary via-primary/70 to-primary/40",
          state === "idle" && "opacity-70",
          state === "thinking" && "animate-pulse",
        )}
        style={{ transform: `scale(${state === "speaking" || state === "listening" ? scale : 1})` }}
      />
      <span className="sr-only">
        {state === "idle" && "Agent idle"}
        {state === "listening" && "Listening"}
        {state === "speaking" && "Agent speaking"}
        {state === "thinking" && "Agent thinking"}
      </span>
    </div>
  );
}
