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
