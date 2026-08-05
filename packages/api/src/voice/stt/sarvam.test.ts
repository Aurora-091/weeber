import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mulawChunkToPcm16Base64 } from "../audio-codec";

/**
 * Hindi/Hinglish (2026-07-16, docs/voice-quality/hindi-hinglish-voice-support.md):
 * regression coverage for the `mode: "codemix"` switch (previously
 * `"transcribe"`). Live-verified against a real Sarvam account and real
 * Hinglish audio — `transcribe` transliterated English loanwords into
 * Devanagari ("order" -> "ऑर्डर"), `codemix` kept them in Latin script,
 * matching Sarvam's own docs guidance for conversational/agent transcripts.
 *
 * Defect 3 (2026-08-05, ADR-072): additional coverage for the real "Hindi
 * agent is not listening" failure. With 160-byte/20ms Twilio frames, sending a
 * full 44-byte WAV header in every JSON message made Sarvam silently return no
 * transcript. The working wire format, proven against the real endpoint with
 * real Hinglish audio, is raw PCM16LE base64 plus Sarvam's still-required
 * legacy `sample_rate`/`encoding` fields.
 */

type Listener = (...args: any[]) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  url: string;
  headers: Record<string, string> | undefined;
  sent: string[] = [];
  readyState = MockWebSocket.CONNECTING;
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = options?.headers;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, cb: Listener) {
    (this.listeners[event] ??= []).push(cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  emit(event: string, payload: unknown = {}) {
    if (event === "open") this.readyState = MockWebSocket.OPEN;
    for (const listener of this.listeners[event] ?? []) listener(payload);
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as any).WebSocket = MockWebSocket;
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
});

function lastSocket() {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

describe("connectSarvamStt", () => {
  it("connects with mode=codemix, not transcribe", async () => {
    const { connectSarvamStt } = await import("./sarvam");
    connectSarvamStt(() => {});

    const ws = lastSocket();
    expect(ws.url).toContain("mode=codemix");
    expect(ws.url).not.toContain("mode=transcribe");
  });

  it("maps Hindi to Sarvam's BCP-47 language-code", async () => {
    const { connectSarvamStt } = await import("./sarvam");
    connectSarvamStt(() => {}, undefined, undefined, undefined, "hi");

    const ws = lastSocket();
    expect(ws.url).toContain("language-code=hi-IN");
    expect(ws.url).toContain("mode=codemix");
  });

  it("maps the shipped Hinglish option to hi-IN instead of rejected hinglish-IN", async () => {
    const { connectSarvamStt, toSarvamLanguageCode } = await import("./sarvam");

    expect(toSarvamLanguageCode("hinglish")).toBe("hi-IN");
    connectSarvamStt(() => {}, undefined, undefined, undefined, "hinglish");

    const ws = lastSocket();
    expect(ws.url).toContain("language-code=hi-IN");
    expect(ws.url).not.toContain("hinglish-IN");
  });

  it("falls back to Sarvam auto-detect for unsupported codes instead of fabricating xx-IN", async () => {
    const { connectSarvamStt, toSarvamLanguageCode } = await import("./sarvam");

    expect(toSarvamLanguageCode("notreal")).toBe("unknown");
    connectSarvamStt(() => {}, undefined, undefined, undefined, "notreal");

    const ws = lastSocket();
    expect(ws.url).toContain("language-code=unknown");
    expect(ws.url).not.toContain("notreal-IN");
  });

  it("buffers Twilio audio while Sarvam is CONNECTING and flushes it on open", async () => {
    const { connectSarvamStt } = await import("./sarvam");
    const conn = connectSarvamStt(() => {});
    const ws = lastSocket();

    conn.sendAudio(new Uint8Array([0xff, 0xfe]));

    expect(ws.sent).toEqual([]);
    ws.emit("open");

    expect(ws.sent).toHaveLength(1);
    const payload = JSON.parse(ws.sent[0]!);
    expect(payload.audio.data).toBe(mulawChunkToPcm16Base64(new Uint8Array([0xff, 0xfe])));
  });

  it("sends raw PCM16LE base64, not a per-frame WAV container", async () => {
    const { connectSarvamStt } = await import("./sarvam");
    const conn = connectSarvamStt(() => {});
    const ws = lastSocket();
    ws.emit("open");

    conn.sendAudio(new Uint8Array([0xff, 0xfe]));

    const payload = JSON.parse(ws.sent[0]!);
    expect(payload).toEqual({
      audio: {
        data: mulawChunkToPcm16Base64(new Uint8Array([0xff, 0xfe])),
        sample_rate: "8000",
        encoding: "audio/wav",
      },
    });
    // "RIFF" in base64; if this shows up, a 44-byte WAV header is being sent
    // on every 20ms Twilio frame again and Sarvam goes silently deaf.
    expect(payload.audio.data).not.toStartWith("UklGR");
  });

  it("escalates Sarvam server error messages to onFatalError so STT failover can engage", async () => {
    const { connectSarvamStt } = await import("./sarvam");
    const onFatalError = mock((_err: unknown) => {});
    connectSarvamStt(() => {}, onFatalError);
    const ws = lastSocket();
    ws.emit("open");

    ws.emit("message", { data: JSON.stringify({ type: "error", data: { message: "bad audio" } }) });

    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(String(onFatalError.mock.calls[0]![0])).toContain("bad audio");
  });
});
