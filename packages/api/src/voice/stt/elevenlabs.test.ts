import { describe, it, expect, beforeEach, afterEach } from "bun:test";

/**
 * Hindi/Hinglish Phase 2 (2026-07-16, docs/hindi-hinglish-voice-support.md):
 * regression coverage for the ElevenLabs Scribe v2 Realtime STT adapter.
 * Exercises actual message construction against a minimal mocked WebSocket
 * (same pattern as tts/language-passthrough.test.ts) — not a live-API test
 * (that was done separately, see the tracking doc for the real transcript).
 * These assertions lock in the two real bugs found and fixed via that live
 * test: `sample_rate`/`audio_format` must be connection-time query params
 * (not per-message fields, which the server silently ignores), and
 * `ulaw_8000` is a valid format — no PCM16 decode step needed.
 */

type Listener = (...args: any[]) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  url: string;
  headers: Record<string, string> | undefined;
  sent: string[] = [];
  readyState = 1;
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
    // no-op
  }

  // Test helpers — not part of the real WebSocket API.
  emitOpen() {
    for (const cb of this.listeners.open ?? []) cb();
  }
  emitMessage(data: unknown) {
    for (const cb of this.listeners.message ?? []) cb({ data: JSON.stringify(data) });
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

describe("connectElevenLabsStt", () => {
  it("connects with model_id, sample_rate, and audio_format=ulaw_8000 as connection query params", async () => {
    const { connectElevenLabsStt } = await import("./elevenlabs");
    connectElevenLabsStt(() => {});

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe(
      "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&sample_rate=8000&audio_format=ulaw_8000",
    );
    expect(ws.headers?.["xi-api-key"]).toBeDefined();
  });

  it("reports connect latency only once session_started arrives, not on raw socket open", async () => {
    const { connectElevenLabsStt } = await import("./elevenlabs");
    const connectedCalls: number[] = [];
    connectElevenLabsStt(() => {}, undefined, undefined, (ms) => connectedCalls.push(ms));

    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    expect(connectedCalls.length).toBe(0); // raw open alone must not fire onConnected

    ws.emitMessage({ message_type: "session_started" });
    expect(connectedCalls.length).toBe(1);
  });

  it("treats partial_transcript as non-final and committed_transcript as final", async () => {
    const { connectElevenLabsStt } = await import("./elevenlabs");
    const transcripts: Array<{ text: string; isFinal: boolean; speechFinal: boolean }> = [];
    connectElevenLabsStt((t) => transcripts.push(t));

    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage({ message_type: "partial_transcript", text: "मुझे flight" });
    ws.emitMessage({ message_type: "committed_transcript", text: "मुझे flight बुक करनी है" });

    expect(transcripts).toEqual([
      { text: "मुझे flight", isFinal: false, speechFinal: false },
      { text: "मुझे flight बुक करनी है", isFinal: true, speechFinal: true },
    ]);
  });

  it("sends mu-law audio completely unconverted (base64 of the raw bytes, no PCM decode)", async () => {
    const { connectElevenLabsStt } = await import("./elevenlabs");
    const conn = connectElevenLabsStt(() => {});

    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    const rawMulaw = new Uint8Array([0xff, 0x7f, 0x00]);
    conn.sendAudio(rawMulaw);

    expect(ws.sent.length).toBe(1);
    const payload = JSON.parse(ws.sent[0]);
    expect(payload.message_type).toBe("input_audio_chunk");
    expect(payload.commit).toBe(false);
    // No per-message sample_rate — that field is ignored by the server;
    // sample_rate/audio_format are set once at connection time (see the
    // first test above). Confirmed via a live test that the server
    // silently defaults to 16kHz PCM if this isn't set at connect time,
    // regardless of what (if anything) is sent per-message.
    expect(payload.sample_rate).toBeUndefined();
    expect(payload.audio_base_64).toBe(Buffer.from(rawMulaw).toString("base64"));
  });

  it("does not send audio before the socket reports open", async () => {
    const { connectElevenLabsStt } = await import("./elevenlabs");
    const conn = connectElevenLabsStt(() => {});
    const ws = MockWebSocket.instances[0];
    // Deliberately no ws.emitOpen() call here.
    conn.sendAudio(new Uint8Array([0x01]));
    expect(ws.sent.length).toBe(0);
  });

  it("sends a final commit message on close", async () => {
    const { connectElevenLabsStt } = await import("./elevenlabs");
    const conn = connectElevenLabsStt(() => {});
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    conn.close();

    expect(ws.sent.length).toBe(1);
    const payload = JSON.parse(ws.sent[0]);
    expect(payload.message_type).toBe("input_audio_chunk");
    expect(payload.commit).toBe(true);
    expect(payload.audio_base_64).toBe("");
  });
});
