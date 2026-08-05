import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { connectDeepgram, toDeepgramNova3Language } from "./deepgram";

/**
 * A1b (VAD/endpointing audit): tests the UtteranceEnd fallback added
 * alongside speech_final — Deepgram's own docs note speech_final can
 * occasionally never fire on a genuinely finished utterance; UtteranceEnd
 * is a second, VAD-driven signal that should replay whatever final text
 * accumulated as a synthetic speech_final in that case, and be a pure no-op
 * when speech_final already handled it normally.
 */

type Listener = (event: { data?: string }) => void;

type FakeSocket = {
  url: string;
  readyState: number;
  listeners: Record<string, Listener[]>;
  sent: unknown[];
  closed: boolean;
  addEventListener(type: string, listener: Listener): void;
  send(data: unknown): void;
  close(): void;
  emit(type: string, event?: { data?: string }): void;
};

/** Factory, not a class — avoids storing `this` (oxlint flags that pattern
 * regardless of context) while still giving the test a handle on the
 * instance `connectDeepgram`'s `new WebSocket(...)` call constructs. */
function makeFakeSocket(url: string): FakeSocket {
  const listeners: Record<string, Listener[]> = {};
  const socket: FakeSocket = {
    url,
    readyState: 1, // OPEN
    listeners,
    sent: [],
    closed: false,
    addEventListener(type, listener) {
      (listeners[type] ??= []).push(listener);
    },
    send(data) {
      socket.sent.push(data);
    },
    close() {
      socket.closed = true;
    },
    emit(type, event = {}) {
      for (const l of listeners[type] ?? []) l(event);
    },
  };
  return socket;
}

let lastSocket: FakeSocket | undefined;
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  lastSocket = undefined;
  const fakeCtor = function (url: string) {
    lastSocket = makeFakeSocket(url);
    return lastSocket;
  };
  fakeCtor.OPEN = 1;
  // @ts-expect-error test stub, not a full WebSocket implementation
  globalThis.WebSocket = fakeCtor;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

function open() {
  lastSocket!.emit("open");
}

describe("connectDeepgram — A1b VAD/endpointing audit", () => {
  test("sets utterance_end_ms so Deepgram actually sends UtteranceEnd events", () => {
    connectDeepgram(() => {});
    open();
    expect(lastSocket!.url).toContain("utterance_end_ms=1000");
    expect(lastSocket!.url).toContain("vad_events=true");
  });

  test("normal speech_final path is unaffected — passes the chunk straight through", () => {
    const onTranscript = mock(() => {});
    connectDeepgram(onTranscript);
    open();

    lastSocket!.emit("message", {
      data: JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: "book me an appointment" }] },
      }),
    });

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith({ text: "book me an appointment", isFinal: true, speechFinal: true });
  });

  test("UtteranceEnd replays accumulated final text as a synthetic speech_final when speech_final never fired", () => {
    const onTranscript = mock(() => {});
    connectDeepgram(onTranscript);
    open();

    // Two `is_final:true` chunks arrive, but speech_final never fires for
    // either — the exact gap this fix targets.
    lastSocket!.emit("message", {
      data: JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: "book me" }] },
      }),
    });
    lastSocket!.emit("message", {
      data: JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: "an appointment" }] },
      }),
    });
    expect(onTranscript).toHaveBeenCalledTimes(2);

    lastSocket!.emit("message", { data: JSON.stringify({ type: "UtteranceEnd" }) });

    expect(onTranscript).toHaveBeenCalledTimes(3);
    expect(onTranscript).toHaveBeenLastCalledWith({ text: "book me an appointment", isFinal: true, speechFinal: true });
  });

  test("UtteranceEnd is a no-op when speech_final already fired normally", () => {
    const onTranscript = mock(() => {});
    connectDeepgram(onTranscript);
    open();

    lastSocket!.emit("message", {
      data: JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: "goodbye" }] },
      }),
    });
    expect(onTranscript).toHaveBeenCalledTimes(1);

    lastSocket!.emit("message", { data: JSON.stringify({ type: "UtteranceEnd" }) });
    // Buffer was cleared by the real speech_final — nothing further fires.
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  test("interim (non-final) results are passed through but never populate the fallback buffer", () => {
    const onTranscript = mock(() => {});
    connectDeepgram(onTranscript);
    open();

    lastSocket!.emit("message", {
      data: JSON.stringify({
        type: "Results",
        is_final: false,
        speech_final: false,
        channel: { alternatives: [{ transcript: "book" }] },
      }),
    });
    expect(onTranscript).toHaveBeenCalledWith({ text: "book", isFinal: false, speechFinal: false });

    lastSocket!.emit("message", { data: JSON.stringify({ type: "UtteranceEnd" }) });
    // Only interim text ever arrived — nothing to replay.
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });
});

/**
 * Defect 3 (2026-08-05, ADR-072): a `language` value nova-3 doesn't accept
 * makes the handshake fail with HTTP 400, so the socket never opens, the
 * bounded reconnect burns all 3 attempts and the call goes deaf. Verified live
 * against the real endpoint: `hi`, `mr`, `ta`, `te`, `kn`, `bn`, `gu`, `pa`
 * and `multi` return 101; `hinglish`, `ml` and `hi-IN` return 400. "hinglish"
 * ships in RECOMMENDED_LANGUAGES, so this was reachable from the UI.
 */
describe("toDeepgramNova3Language", () => {
  test("omits the param entirely for English / no language", () => {
    expect(toDeepgramNova3Language(undefined)).toBeUndefined();
    expect(toDeepgramNova3Language("en")).toBeUndefined();
  });

  test("passes through the Indic codes nova-3 actually accepts", () => {
    for (const code of ["hi", "mr", "ta", "te", "kn", "bn", "gu", "pa", "multi"]) {
      expect(toDeepgramNova3Language(code)).toBe(code);
    }
  });

  test("routes hinglish to multi instead of a code nova-3 rejects with 400", () => {
    expect(toDeepgramNova3Language("hinglish")).toBe("multi");
  });

  test("routes Malayalam to multi — nova-3 rejects 'ml' outright", () => {
    expect(toDeepgramNova3Language("ml")).toBe("multi");
  });

  test("strips a region suffix rather than sending the rejected hi-IN form", () => {
    expect(toDeepgramNova3Language("hi-IN")).toBe("hi");
  });

  test("falls back to multi for anything unrecognized", () => {
    expect(toDeepgramNova3Language("klingon")).toBe("multi");
  });
});

describe("connectDeepgram — language param", () => {
  test("never puts a nova-3-rejected language on the connection URL", () => {
    connectDeepgram(() => {}, undefined, undefined, undefined, "hinglish");
    open();
    expect(lastSocket!.url).toContain("language=multi");
    expect(lastSocket!.url).not.toContain("language=hinglish");
  });

  test("leaves the URL language-free for English", () => {
    connectDeepgram(() => {}, undefined, undefined, undefined, "en");
    open();
    expect(lastSocket!.url).not.toContain("language=");
  });
});
