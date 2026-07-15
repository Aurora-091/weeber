import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { listVoicesForProvider } from "./voices-catalog";

const originalFetch = global.fetch;
const originalKey = process.env.CARTESIA_API_KEY;

// Regression test for the 2026-07-15 bug: the merchant voice picker's
// inline "play" button silently did nothing on Cartesia voices, because
// listCartesiaVoices() hardcoded the preview proxy URL to the admin-only
// route (/api/voice/voices/cartesia-preview/:id, requireAdminKey-gated) no
// matter which surface asked for the list — a merchant session has no
// admin key, so the preview fetch always 401'd, and the frontend's catch
// block swallowed it with no visible error.
describe("listVoicesForProvider — Cartesia scope-aware preview URLs", () => {
  beforeEach(() => {
    process.env.CARTESIA_API_KEY = "test-key";
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "voice-1", name: "Test Voice", preview_file_url: "https://cartesia.example/preview.mp3" }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.CARTESIA_API_KEY = originalKey;
  });

  it("points at the admin-scoped proxy route when called with scope 'admin' (or omitted, the default)", async () => {
    const voices = await listVoicesForProvider("cartesia", "admin");
    expect(voices[0]?.previewUrl).toBe("/api/voice/voices/cartesia-preview/voice-1");

    const voicesDefaultScope = await listVoicesForProvider("cartesia");
    expect(voicesDefaultScope[0]?.previewUrl).toBe("/api/voice/voices/cartesia-preview/voice-1");
  });

  it("points at the merchant-scoped proxy route when called with scope 'user' — this is the fix", async () => {
    const voices = await listVoicesForProvider("cartesia", "user");
    expect(voices[0]?.previewUrl).toBe("/api/app/voices/cartesia-preview/voice-1");
  });
});
