import { describe, it, expect, beforeEach, afterEach } from "bun:test";

/**
 * Hindi/Hinglish (2026-07-16, docs/hindi-hinglish-voice-support.md):
 * regression coverage for the `mode: "codemix"` switch (previously
 * `"transcribe"`). Live-verified against a real Sarvam account and real
 * Hinglish audio — `transcribe` transliterated English loanwords into
 * Devanagari ("order" -> "ऑर्डर"), `codemix` kept them in Latin script,
 * matching Sarvam's own docs guidance for conversational/agent transcripts.
 * This file had no test coverage before this fix.
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
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as any).WebSocket = MockWebSocket;
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
});

describe("connectSarvamStt — mode=codemix", () => {
  it("connects with mode=codemix, not transcribe", async () => {
    const { connectSarvamStt } = await import("./sarvam");
    connectSarvamStt(() => {});

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain("mode=codemix");
    expect(ws.url).not.toContain("mode=transcribe");
  });

  it("still resolves the language-code param the same way regardless of mode", async () => {
    const { connectSarvamStt } = await import("./sarvam");
    connectSarvamStt(() => {}, undefined, undefined, undefined, "hi");

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain("language-code=hi-IN");
    expect(ws.url).toContain("mode=codemix");
  });
});
