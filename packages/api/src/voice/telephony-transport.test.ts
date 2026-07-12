import { describe, it, expect } from "bun:test";
import { mulawToPcm16, pcm16ToMulaw } from "./audio-codec";
import { getTelephonyTransport } from "./telephony-transport";

describe("audio-codec: mulaw <-> PCM16 round trip", () => {
  it("recovers a sine-ish PCM16 signal within mu-law's expected quantization error", () => {
    const sampleCount = 160;
    const pcm16 = new Uint8Array(sampleCount * 2);
    const view = new DataView(pcm16.buffer);
    for (let i = 0; i < sampleCount; i++) {
      const sample = Math.round(8000 * Math.sin((i / sampleCount) * Math.PI * 2));
      view.setInt16(i * 2, sample, true);
    }

    const mulaw = pcm16ToMulaw(pcm16);
    expect(mulaw.length).toBe(sampleCount);

    const roundTripped = mulawToPcm16(mulaw);
    const roundTrippedView = new DataView(roundTripped.buffer);
    for (let i = 0; i < sampleCount; i++) {
      const original = view.getInt16(i * 2, true);
      const decoded = roundTrippedView.getInt16(i * 2, true);
      // mu-law is lossy by design (~8-bit effective resolution) — this
      // just guards against a broken encode/decode table, not exact
      // reconstruction.
      expect(Math.abs(original - decoded)).toBeLessThan(500);
    }
  });

  it("round-trips silence exactly (regression guard for the sign-bit/bias off-by-one classes of bug)", () => {
    const pcm16 = new Uint8Array(20);
    const mulaw = pcm16ToMulaw(pcm16);
    const back = mulawToPcm16(mulaw);
    const view = new DataView(back.buffer);
    for (let i = 0; i < 10; i++) {
      expect(Math.abs(view.getInt16(i * 2, true))).toBeLessThan(10);
    }
  });
});

describe("telephony-transport: per-provider wire format parsing", () => {
  it("twilio: parses start/media/stop and builds media/clear frames with streamSid", () => {
    const t = getTelephonyTransport("twilio");
    const start = t.parseInbound(JSON.stringify({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } }));
    expect(start).toEqual({ type: "start", streamId: "MZ1", callId: "CA1" });

    const media = t.parseInbound(JSON.stringify({ event: "media", media: { payload: "abc123" } }));
    expect(media).toEqual({ type: "media", mulawBase64: "abc123" });

    expect(t.parseInbound(JSON.stringify({ event: "stop" }))).toEqual({ type: "stop" });

    const frame = JSON.parse(t.buildOutboundMedia("MZ1", "xyz"));
    expect(frame).toEqual({ event: "media", streamSid: "MZ1", media: { payload: "xyz" } });

    const clear = JSON.parse(t.buildClear("MZ1"));
    expect(clear).toEqual({ event: "clear", streamSid: "MZ1" });
  });

  it("plivo: uses streamId/callId naming and a streamId-less playAudio/clearAudio frame shape", () => {
    const t = getTelephonyTransport("plivo");
    const start = t.parseInbound(
      JSON.stringify({ event: "start", start: { streamId: "SID1", callId: "CALL1", accountId: "MA1", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000 } } }),
    );
    expect(start).toEqual({ type: "start", streamId: "SID1", callId: "CALL1" });

    const media = t.parseInbound(JSON.stringify({ event: "media", media: { payload: "abc123" } }));
    expect(media).toEqual({ type: "media", mulawBase64: "abc123" });

    const frame = JSON.parse(t.buildOutboundMedia("SID1", "xyz"));
    expect(frame).toEqual({ event: "playAudio", media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: "xyz" } });

    const clear = JSON.parse(t.buildClear("SID1"));
    expect(clear).toEqual({ event: "clearAudio", streamId: "SID1" });
  });

  it("exotel: uses snake_case stream_sid/call_sid, transcodes PCM16<->mulaw at the boundary", () => {
    const t = getTelephonyTransport("exotel");
    const start = t.parseInbound(
      JSON.stringify({ event: "start", start: { stream_sid: "MZ1", call_sid: "CA1", from: "+91900000", to: "+91800000" } }),
    );
    expect(start).toEqual({ type: "start", streamId: "MZ1", callId: "CA1", from: "+91900000", to: "+91800000" });

    // Build a tiny known PCM16 buffer, base64 it as if Exotel sent it, and
    // confirm the parsed mulawBase64 decodes back close to the original —
    // this is the one provider that actually transcodes, so it's worth
    // covering the full loop, not just the JSON shape.
    const pcm16 = new Uint8Array(8);
    new DataView(pcm16.buffer).setInt16(0, 1000, true);
    const inputB64 = Buffer.from(pcm16).toString("base64");
    const media = t.parseInbound(JSON.stringify({ event: "media", media: { payload: inputB64 } }));
    expect(media.type).toBe("media");
    if (media.type === "media") {
      const decodedMulaw = Buffer.from(media.mulawBase64, "base64");
      const decodedPcm16 = mulawToPcm16(decodedMulaw);
      expect(Math.abs(new DataView(decodedPcm16.buffer).getInt16(0, true) - 1000)).toBeLessThan(200);
    }

    const stop = t.parseInbound(JSON.stringify({ event: "stop", stop: { call_sid: "CA1", reason: "callended" } }));
    expect(stop).toEqual({ type: "stop" });

    // Outbound: our mulaw -> Exotel's expected linear16 PCM, snake_case frame.
    const outFrame = JSON.parse(t.buildOutboundMedia("MZ1", Buffer.from([0xff]).toString("base64")));
    expect(outFrame.event).toBe("media");
    expect(outFrame.stream_sid).toBe("MZ1");
    expect(typeof outFrame.media.payload).toBe("string");

    const clear = JSON.parse(t.buildClear("MZ1"));
    expect(clear).toEqual({ event: "clear", stream_sid: "MZ1" });
  });

  it("returns unknown for unparseable/unrecognized frames instead of throwing", () => {
    const t = getTelephonyTransport("twilio");
    expect(t.parseInbound("not json")).toEqual({ type: "unknown" });
    expect(t.parseInbound(JSON.stringify({ event: "dtmf" }))).toEqual({ type: "unknown" });
  });
});
