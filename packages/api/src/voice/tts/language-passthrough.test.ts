import { describe, it, expect, beforeEach, afterEach } from "bun:test";

/**
 * Hindi/Hinglish fix (2026-07-16, docs/hindi-hinglish-voice-support.md):
 * regression coverage for the ElevenLabs `language_code` query param and
 * Cartesia `language` payload field, both of which used to be silently
 * dropped (ElevenLabs never accepted a `language` argument at all; Cartesia
 * received it as `_language` and never sent it). Neither adapter had any
 * test coverage before this — this file exercises the actual WebSocket URL/
 * payload construction against a minimal mock, not just type-level checks.
 */

type Listener = (...args: any[]) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  url: string;
  sent: string[] = [];
  readyState = 1; // OPEN — these adapters check `ws.readyState === WebSocket.OPEN`
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

  close() {
    // no-op — nothing under test here reads close behavior
  }

  // Test helper — not part of the real WebSocket API.
  emitOpen() {
    for (const cb of this.listeners.open ?? []) cb();
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

describe("connectElevenLabsTts — language_code passthrough", () => {
  it("appends language_code to the connection URL when a language is set", async () => {
    const { connectElevenLabsTts } = await import("./elevenlabs");
    connectElevenLabsTts(() => {}, undefined, undefined, "voice-abc", "hi");

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain("language_code=hi");
  });

  it("omits language_code entirely when no language is configured", async () => {
    const { connectElevenLabsTts } = await import("./elevenlabs");
    connectElevenLabsTts(() => {}, undefined, undefined, "voice-abc", undefined);

    const ws = MockWebSocket.instances[0];
    expect(ws.url).not.toContain("language_code");
  });

  it("never forwards Deepgram's \"multi\" STT mode as an ElevenLabs language_code", async () => {
    const { connectElevenLabsTts } = await import("./elevenlabs");
    connectElevenLabsTts(() => {}, undefined, undefined, "voice-abc", "multi");

    const ws = MockWebSocket.instances[0];
    expect(ws.url).not.toContain("language_code");
  });
});

describe("connectElevenLabsTts — pronunciation dictionary (Phase 3, 2026-07-16)", () => {
  const originalDictId = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID;
  const originalDictVersionId = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID;

  afterEach(() => {
    if (originalDictId === undefined) delete process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID;
    else process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID = originalDictId;
    if (originalDictVersionId === undefined) delete process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID;
    else process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID = originalDictVersionId;
  });

  it("includes pronunciation_dictionary_locators in the initial handshake message when both env vars are set", async () => {
    process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID = "dict-123";
    process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID = "ver-456";
    const { connectElevenLabsTts } = await import("./elevenlabs");
    connectElevenLabsTts(() => {}, undefined, undefined, "voice-abc");

    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    const handshake = JSON.parse(ws.sent[0]);
    expect(handshake.pronunciation_dictionary_locators).toEqual([
      { pronunciation_dictionary_id: "dict-123", version_id: "ver-456" },
    ]);
  });

  it("omits pronunciation_dictionary_locators entirely when the env vars are unset", async () => {
    delete process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID;
    delete process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID;
    const { connectElevenLabsTts } = await import("./elevenlabs");
    connectElevenLabsTts(() => {}, undefined, undefined, "voice-abc");

    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    const handshake = JSON.parse(ws.sent[0]);
    expect(handshake.pronunciation_dictionary_locators).toBeUndefined();
  });

  it("omits it when only one of the two required env vars is set (both required together)", async () => {
    process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID = "dict-123";
    delete process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID;
    const { connectElevenLabsTts } = await import("./elevenlabs");
    connectElevenLabsTts(() => {}, undefined, undefined, "voice-abc");

    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    const handshake = JSON.parse(ws.sent[0]);
    expect(handshake.pronunciation_dictionary_locators).toBeUndefined();
  });
});

describe("connectCartesiaTts — language field passthrough", () => {
  it("includes a top-level language field in the generation request when a language is set", async () => {
    const { connectCartesiaTts } = await import("./cartesia");
    const conn = connectCartesiaTts(() => {}, undefined, undefined, "voice-abc", "hi");
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    conn.sendText("नमस्ते");

    const payload = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(payload.language).toBe("hi");
  });

  it("omits the language field entirely when no language is configured", async () => {
    const { connectCartesiaTts } = await import("./cartesia");
    const conn = connectCartesiaTts(() => {}, undefined, undefined, "voice-abc", undefined);
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    conn.sendText("hello");

    const payload = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(payload.language).toBeUndefined();
  });

  it("never forwards Deepgram's \"multi\" STT mode as a Cartesia language", async () => {
    const { connectCartesiaTts } = await import("./cartesia");
    const conn = connectCartesiaTts(() => {}, undefined, undefined, "voice-abc", "multi");
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    conn.sendText("hello");

    const payload = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(payload.language).toBeUndefined();
  });
});
