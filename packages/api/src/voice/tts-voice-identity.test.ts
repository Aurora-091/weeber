import { describe, it, expect } from "bun:test";
import { voiceIdForProvider } from "./tts-voice-identity";

/**
 * Defect: "the agent's voice changes during the call."
 *
 * Before this rule existed, stream.ts's per-turn TTS failover passed the
 * agent's configured `voiceId` to *whatever* provider it fell over to. A
 * Cartesia UUID handed to ElevenLabs goes into the WebSocket URL path (404s
 * the turn), and handed to Sarvam it is not a valid speaker name — and every
 * adapter falls back to its own env-default voice rather than reporting a
 * config error, so the failure mode is "caller hears a different person",
 * never an exception the pipeline can act on.
 */
describe("voiceIdForProvider", () => {
  it("forwards the configured voice ID to the provider it was configured for", () => {
    expect(voiceIdForProvider("a1b2c3-cartesia-uuid", "cartesia", "cartesia")).toBe("a1b2c3-cartesia-uuid");
    expect(voiceIdForProvider("shubh", "sarvam", "sarvam")).toBe("shubh");
  });

  it("never forwards a voice ID to a different provider (the failover leak)", () => {
    // Cartesia primary -> ElevenLabs fallback: the UUID would be interpolated
    // into ElevenLabs' WebSocket URL path.
    expect(voiceIdForProvider("a1b2c3-cartesia-uuid", "cartesia", "elevenlabs")).toBeUndefined();
    // ...and -> Sarvam, where it is not a valid speaker name.
    expect(voiceIdForProvider("a1b2c3-cartesia-uuid", "cartesia", "sarvam")).toBeUndefined();
    // Symmetrically, a Sarvam speaker name means nothing to the others.
    expect(voiceIdForProvider("shubh", "sarvam", "cartesia")).toBeUndefined();
    expect(voiceIdForProvider("shubh", "sarvam", "elevenlabs")).toBeUndefined();
  });

  it("forwards nothing when no voice ID is configured", () => {
    expect(voiceIdForProvider(undefined, "cartesia", "cartesia")).toBeUndefined();
    expect(voiceIdForProvider("", "cartesia", "cartesia")).toBeUndefined();
  });

  it("treats an unknown owner as a mismatch rather than guessing", () => {
    // No provider was ever recorded for this voice ID, so it cannot be proven
    // legal for the target — the target's own default voice is the safe answer.
    expect(voiceIdForProvider("a1b2c3-cartesia-uuid", undefined, "cartesia")).toBeUndefined();
    expect(voiceIdForProvider("a1b2c3-cartesia-uuid", undefined, "sarvam")).toBeUndefined();
  });
});

/**
 * Voice-pipeline hardening plan, Stage 5 (2026-09-05) — an agent that opts
 * into `voiceIdsByProvider` keeps a real, consistent identity across a TTS
 * failover instead of falling back to whichever provider's platform-default
 * voice. One agent's `voiceId`/`voiceProvider` is still exactly one pair for
 * one provider (the primary); this mapping is the opt-in extension.
 */
describe("voiceIdForProvider — Stage 5 per-provider voice mapping", () => {
  it("uses the mapped ID for the provider being attempted, even when it differs from the primary pair", () => {
    const map = { cartesia: "cartesia-id", elevenlabs: "el-id", sarvam: "sarvam-speaker" };
    expect(voiceIdForProvider("cartesia-id", "cartesia", "elevenlabs", map)).toBe("el-id");
    expect(voiceIdForProvider("cartesia-id", "cartesia", "sarvam", map)).toBe("sarvam-speaker");
  });

  it("falls through to the single-provider pair for a provider missing from the map", () => {
    const map = { cartesia: "cartesia-id" }; // no elevenlabs/sarvam entry
    expect(voiceIdForProvider("cartesia-id", "cartesia", "cartesia", map)).toBe("cartesia-id");
    expect(voiceIdForProvider("cartesia-id", "cartesia", "elevenlabs", map)).toBeUndefined();
  });

  it("behaves exactly as before Stage 5 when no map is configured at all", () => {
    expect(voiceIdForProvider("a1b2c3-cartesia-uuid", "cartesia", "cartesia", undefined)).toBe("a1b2c3-cartesia-uuid");
    expect(voiceIdForProvider("a1b2c3-cartesia-uuid", "cartesia", "elevenlabs", undefined)).toBeUndefined();
  });
});
