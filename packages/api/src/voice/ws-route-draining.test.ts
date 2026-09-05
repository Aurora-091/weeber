import { mock, describe, it, expect } from "bun:test";

/**
 * Voice-pipeline hardening plan, Stage 3 (2026-09-05) — deploy draining.
 *
 * This process holds live-call state in memory with no reconnect path, so a
 * deploy previously dropped every in-flight call to dead air the instant
 * SIGTERM arrived. `isDraining`/`activeCallCount` (ws-route.ts) are what
 * server.ts's SIGTERM handler uses to refuse new calls and know when it's
 * actually safe to exit — this asserts those two mechanisms directly,
 * without the real telephony-provider/DB wiring `createVoiceStreamHandlers`
 * would otherwise need mocked.
 */

mock.module("./stream", () => ({
  createVoiceStreamHandlers: () => ({
    onOpen: () => {},
    onMessage: async () => {},
    onClose: () => {},
  }),
}));
mock.module("./test-call-stream", () => ({
  createTestCallStreamHandlers: () => ({
    onOpen: async () => {},
    onMessage: () => {},
    onClose: () => {},
  }),
}));
mock.module("./test-call-tokens", () => ({ consumeTestCallToken: () => null }));
mock.module("./middleware/exotel-auth", () => ({ verifyExotelStreamAuth: async () => ({ ok: true }) }));

const { tryUpgradeVoiceSocket, voiceWebsocketHandlers, beginDraining, getActiveCallCount } = await import("./ws-route");

function fakeUpgradeServer() {
  const calls: unknown[] = [];
  return { calls, upgrade: (...args: unknown[]) => (calls.push(args), true) };
}

describe("deploy draining (Stage 3)", () => {
  // beginDraining() has no undo by design (a drained process is expected to
  // exit, not un-drain), so the "still accepts calls before draining"
  // assertion has to run in the same test as the drain transition, before
  // beginDraining() is called — not split across two tests relying on file
  // execution order to keep them apart.
  it("accepts a call before draining starts, then refuses new ones once it does", async () => {
    const server = fakeUpgradeServer();
    const request = new Request("https://api.weeber.test/api/voice/stream", { method: "GET" });

    const beforeDrain = await tryUpgradeVoiceSocket(request, server);
    expect(beforeDrain).toBe(true);
    expect(server.calls.length).toBe(1);

    beginDraining();

    const afterDrain = await tryUpgradeVoiceSocket(request, server);
    expect(afterDrain).toBe(false);
    // The whole point: draining must reject BEFORE server.upgrade() is ever
    // called, not upgrade-then-immediately-close.
    expect(server.calls.length).toBe(1);
  });

  it("tracks active voice calls so a drain wait knows when it's actually safe to exit", () => {
    const initial = getActiveCallCount();
    const ws = { data: { kind: "voice" as const, handlers: { onOpen: () => {}, onClose: () => {} } } };

    voiceWebsocketHandlers.open(ws as never);
    expect(getActiveCallCount()).toBe(initial + 1);

    voiceWebsocketHandlers.close(ws as never);
    expect(getActiveCallCount()).toBe(initial);
  });

  it("does not count a test-call (Preview drawer) socket toward the drain wait", () => {
    const initial = getActiveCallCount();
    const ws = { data: { kind: "test-call" as const, handlers: { onOpen: async () => {}, onClose: () => {} } } };

    voiceWebsocketHandlers.open(ws as never);
    expect(getActiveCallCount()).toBe(initial);

    voiceWebsocketHandlers.close(ws as never);
    expect(getActiveCallCount()).toBe(initial);
  });
});
