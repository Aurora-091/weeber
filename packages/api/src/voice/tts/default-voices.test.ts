import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { FALLBACK_VOICE_BY_PROVIDER, resolveVoiceId } from "./default-voices";
import type { TtsProvider } from "./types";

/**
 * ADR-102: a voice is an agent property, not a deployment property. These
 * tests pin the two things that broke when it was an env var:
 *
 *  1. Every provider has a fallback voice, so the withheld-ID path that
 *     `tts-voice-identity.ts` deliberately takes during cross-provider
 *     failover always has a real voice to land on.
 *  2. No adapter ever puts the string "undefined" on the wire — the exact
 *     production defect (ELEVENLABS_VOICE_ID unset → a request against voice
 *     `undefined`), which was invisible to every existing test because they
 *     all passed an explicit voice ID.
 */

const ALL_PROVIDERS: TtsProvider[] = ["cartesia", "elevenlabs", "sarvam"];

describe("resolveVoiceId (ADR-102)", () => {
  it("returns the agent's configured voice when it has one", () => {
    expect(resolveVoiceId("cartesia", "agent-voice-uuid")).toBe("agent-voice-uuid");
    expect(resolveVoiceId("elevenlabs", "agent-voice-id")).toBe("agent-voice-id");
    expect(resolveVoiceId("sarvam", "anushka")).toBe("anushka");
  });

  it("falls back to the provider's own voice when the agent has none", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(resolveVoiceId(provider, undefined)).toBe(FALLBACK_VOICE_BY_PROVIDER[provider]);
    }
  });

  it("treats blank and whitespace-only as not configured", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(resolveVoiceId(provider, "")).toBe(FALLBACK_VOICE_BY_PROVIDER[provider]);
      expect(resolveVoiceId(provider, "   ")).toBe(FALLBACK_VOICE_BY_PROVIDER[provider]);
    }
  });

  it("trims a configured voice ID rather than sending surrounding whitespace", () => {
    // Real precedent: org_agent_configs has a row whose `name` is "alice "
    // with a trailing space, so operator-entered values here are not clean.
    expect(resolveVoiceId("sarvam", "  anushka  ")).toBe("anushka");
  });

  it("declares a non-empty fallback for every registered provider", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(FALLBACK_VOICE_BY_PROVIDER[provider]).toBeTruthy();
      expect(FALLBACK_VOICE_BY_PROVIDER[provider].trim()).toBe(FALLBACK_VOICE_BY_PROVIDER[provider]);
    }
  });

  it("never reads a <PROVIDER>_VOICE_ID env var", () => {
    const saved = {
      CARTESIA_VOICE_ID: process.env.CARTESIA_VOICE_ID,
      ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
      SARVAM_VOICE_ID: process.env.SARVAM_VOICE_ID,
    };
    process.env.CARTESIA_VOICE_ID = "env-cartesia";
    process.env.ELEVENLABS_VOICE_ID = "env-elevenlabs";
    process.env.SARVAM_VOICE_ID = "env-sarvam";
    try {
      for (const provider of ALL_PROVIDERS) {
        expect(resolveVoiceId(provider, undefined)).toBe(FALLBACK_VOICE_BY_PROVIDER[provider]);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// --- Wire-level: the adapters, with no voice configured anywhere ------------

type Listener = (...args: any[]) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  url: string;
  sent: string[] = [];
  readyState = 1;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  addEventListener(event: string, cb: Listener) {
    (this.listeners[event] ??= []).push(cb);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  emitOpen() {
    for (const cb of this.listeners.open ?? []) cb();
  }
}

const originalWebSocket = globalThis.WebSocket;
const savedVoiceEnv = {
  CARTESIA_VOICE_ID: process.env.CARTESIA_VOICE_ID,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
  SARVAM_VOICE_ID: process.env.SARVAM_VOICE_ID,
};

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as any).WebSocket = MockWebSocket;
  // The production condition that caused the defect: no voice env vars at all.
  delete process.env.CARTESIA_VOICE_ID;
  delete process.env.ELEVENLABS_VOICE_ID;
  delete process.env.SARVAM_VOICE_ID;
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
  for (const [k, v] of Object.entries(savedVoiceEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("TTS adapters with no voice configured (the ADR-102 defect)", () => {
  it("ElevenLabs puts a real voice ID in the URL path, never \"undefined\"", async () => {
    const { connectElevenLabsTts } = await import("./elevenlabs");
    connectElevenLabsTts(() => {}, undefined, undefined, undefined, "en");

    const ws = MockWebSocket.instances[0];
    expect(ws.url).not.toContain("undefined");
    expect(ws.url).toContain(`/text-to-speech/${FALLBACK_VOICE_BY_PROVIDER.elevenlabs}/stream-input`);
  });

  it("Cartesia sends a real voice.id in the generation payload", async () => {
    const { connectCartesiaTts } = await import("./cartesia");
    const tts = connectCartesiaTts(() => {}, undefined, undefined, undefined, "en");
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    tts.sendText("hello");

    const payload = JSON.parse(ws.sent.at(-1)!);
    expect(payload.voice).toEqual({ mode: "id", id: FALLBACK_VOICE_BY_PROVIDER.cartesia });
  });

  it("Sarvam sends its default speaker name", async () => {
    const { connectSarvamTts } = await import("./sarvam");
    connectSarvamTts(() => {}, undefined, undefined, undefined, "hi");
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();

    const allSent = ws.sent.join(" ");
    expect(allSent).toContain(FALLBACK_VOICE_BY_PROVIDER.sarvam);
    expect(allSent).not.toContain("undefined");
  });

  it("an explicitly configured voice still wins for every provider", async () => {
    const { connectElevenLabsTts } = await import("./elevenlabs");
    connectElevenLabsTts(() => {}, undefined, undefined, "agent-picked-voice", "en");
    expect(MockWebSocket.instances[0].url).toContain("/text-to-speech/agent-picked-voice/stream-input");

    const { connectCartesiaTts } = await import("./cartesia");
    const tts = connectCartesiaTts(() => {}, undefined, undefined, "agent-picked-uuid", "en");
    const cartesiaWs = MockWebSocket.instances[1];
    cartesiaWs.emitOpen();
    tts.sendText("hello");
    expect(JSON.parse(cartesiaWs.sent.at(-1)!).voice.id).toBe("agent-picked-uuid");
  });
});
