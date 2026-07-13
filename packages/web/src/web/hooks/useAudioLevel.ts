import { useEffect, useRef, useState } from "react";

/**
 * Reads a live 0-1 amplitude level off an <audio> element via the Web Audio
 * API (AnalyserNode), sampled on every animation frame. Powers VoiceOrb's
 * "speaking" pulse during TTS preview playback (Phase 1 of
 * AGENT-CONSOLE-UI-PLAN.md — reacting to existing TTS audio only; Phase 2
 * adds a real mic-input level the same way, off a MediaStream instead of an
 * <audio> element).
 *
 * One AudioContext + MediaElementSourceNode per <audio> element for its
 * lifetime — createMediaElementSource can only be called once per element,
 * so this is intentionally re-entrant-safe via the ref guard below rather
 * than recreated on every render.
 */
export function useAudioLevel(audioEl: HTMLAudioElement | null): number {
  const [level, setLevel] = useState(0);
  const wiredRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!audioEl || wiredRef.current === audioEl) return;

    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let data: Uint8Array<ArrayBuffer> | null = null;

    try {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaElementSource(audioEl);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      data = new Uint8Array(analyser.frequencyBinCount);
      wiredRef.current = audioEl;
    } catch {
      // Element already wired elsewhere, or Web Audio unsupported — the orb
      // just stays static (idle state) rather than erroring the page.
      return;
    }

    function tick() {
      if (!analyser || !data) return;
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
      setLevel(Math.min(1, avg / 128));
      rafRef.current = requestAnimationFrame(tick);
    }
    tick();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setLevel(0);
    };
  }, [audioEl]);

  return level;
}
