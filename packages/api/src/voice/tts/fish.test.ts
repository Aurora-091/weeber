import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { encode, decode } from "@msgpack/msgpack";

/**
 * Fish Audio adapter (2026-08-25) — protocol-shape tests against a mocked
 * WebSocket, same as this directory's other provider tests. **This proves
 * the adapter's own logic is internally consistent with what this session's
 * research found documented — it does not prove Fish Audio's real server
 * behaves this way.** No live account exists in this sandbox to confirm
 * against. See tts/fish.ts's doc comment.
 */

type Listener = (...args: any[]) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  url: string;
  headers: Record<string, string> | undefined;
  sent: Uint8Array[] = [];
  readyState = MockWebSocket.CONNECTING;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string, opts?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = opts?.headers;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, cb: Listener) {
    (this.listeners[event] ??= []).push(cb);
  }

  send(data: Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  // Test helpers — not part of the real WebSocket API.
  emitOpen() {
    this.readyState = MockWebSocket.OPEN;
    for (const cb of this.listeners.open ?? []) cb();
  }
  emitMessage(payload: Record<string, unknown>) {
    for (const cb of this.listeners.message ?? []) cb({ data: encode(payload) });
  }
  emitClose(code = 1000, reason = "") {
    for (const cb of this.listeners.close ?? []) cb({ code, reason });
  }

  lastSentDecoded(): any {
    return decode(this.sent.at(-1)!);
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalApiKey = process.env.FISH_API_KEY;

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as any).WebSocket = MockWebSocket;
  process.env.FISH_API_KEY = "test-key";
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
  if (originalApiKey === undefined) delete process.env.FISH_API_KEY;
  else process.env.FISH_API_KEY = originalApiKey;
});

describe("connectFishSession — protocol shape", () => {
  it("connects with a Bearer auth header and sends a msgpack start event on open", async () => {
    const { connectFishSession } = await import("./fish");
    const session = connectFishSession("voice-abc", "en", () => {});
    session.startTurn(() => {});

    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe("wss://api.fish.audio/v1/tts/live");
    expect(ws.headers?.Authorization).toBe("Bearer test-key");

    ws.emitOpen();
    const start = ws.lastSentDecoded();
    expect(start.event).toBe("start");
    expect(start.request.format).toBe("pcm");
    expect(start.request.reference_id).toBe("voice-abc");
  });

  it("omits reference_id entirely rather than sending an empty string when no voice is configured", async () => {
    const { connectFishSession } = await import("./fish");
    const session = connectFishSession(undefined, "en", () => {});
    session.startTurn(() => {});

    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    const start = ws.lastSentDecoded();
    expect("reference_id" in start.request).toBe(false);
  });

  it("queues sendText calls made before open, then flushes them as msgpack text events", async () => {
    const { connectFishSession } = await import("./fish");
    const session = connectFishSession("voice-abc", "en", () => {});
    const turn = session.startTurn(() => {});
    turn.sendText("hello");

    const ws = MockWebSocket.instances[0]!;
    expect(ws.sent.length).toBe(0); // nothing sent before open
    ws.emitOpen();
    // sent[0] is the start event, sent[1] is the queued text.
    expect(ws.sent.length).toBe(2);
    const text = decode(ws.sent[1]!) as any;
    expect(text).toEqual({ event: "text", text: "hello" });
  });

  it("endTurn sends a msgpack stop event", async () => {
    const { connectFishSession } = await import("./fish");
    const session = connectFishSession("voice-abc", "en", () => {});
    const turn = session.startTurn(() => {});
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    turn.endTurn();
    expect(ws.lastSentDecoded()).toEqual({ event: "stop" });
  });

  it("decodes an audio event, resamples 44.1kHz PCM to 8kHz mu-law, and calls onAudioChunk", async () => {
    const { connectFishSession } = await import("./fish");
    const chunks: string[] = [];
    const session = connectFishSession("voice-abc", "en", () => {});
    session.startTurn((b64) => chunks.push(b64));
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();

    // 4410 samples at 44100Hz = 100ms of audio -> ~800 samples at 8000Hz.
    const samples = new Int16Array(4410).fill(1000);
    const pcm = new Uint8Array(samples.buffer);
    ws.emitMessage({ event: "audio", audio: pcm });

    expect(chunks.length).toBe(1);
    const mulawBytes = Buffer.from(chunks[0]!, "base64");
    // mu-law is 1 byte/sample, so the byte count IS the resampled sample count.
    expect(mulawBytes.length).toBeGreaterThan(700);
    expect(mulawBytes.length).toBeLessThan(900);
  });

  it("calls onDone on a finish event with reason stop", async () => {
    const { connectFishSession } = await import("./fish");
    let done = false;
    const session = connectFishSession("voice-abc", "en", () => {});
    session.startTurn(
      () => {},
      () => (done = true),
    );
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitMessage({ event: "finish", reason: "stop" });
    expect(done).toBe(true);
  });

  it("calls onError on a finish event with reason error", async () => {
    const { connectFishSession } = await import("./fish");
    let error: unknown;
    const session = connectFishSession("voice-abc", "en", () => {});
    session.startTurn(
      () => {},
      undefined,
      (err) => (error = err),
    );
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitMessage({ event: "finish", reason: "error" });
    expect(error).toBeInstanceOf(Error);
  });

  it("does not report an error for a socket the caller closed intentionally", async () => {
    const { connectFishSession } = await import("./fish");
    let error: unknown;
    const session = connectFishSession("voice-abc", "en", () => {});
    const turn = session.startTurn(
      () => {},
      undefined,
      (err) => (error = err),
    );
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    turn.close();
    ws.emitClose(1000, "");
    expect(error).toBeUndefined();
  });

  it("opens a brand-new socket on every startTurn — no multiplexed reuse (see doc comment on why)", async () => {
    const { connectFishSession } = await import("./fish");
    const session = connectFishSession("voice-abc", "en", () => {});
    session.startTurn(() => {});
    session.startTurn(() => {});
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it("isOpen() is always true at the session level, regardless of any per-turn socket state", async () => {
    const { connectFishSession } = await import("./fish");
    const session = connectFishSession("voice-abc", "en", () => {});
    expect(session.isOpen()).toBe(true);
    session.startTurn(() => {});
    expect(session.isOpen()).toBe(true);
  });
});
