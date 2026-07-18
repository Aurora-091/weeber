import { describe, it, expect } from "bun:test";
import { estimateCallCostCents } from "./cost-estimate";

describe("estimateCallCostCents", () => {
  it("returns null when durationSeconds is 0 or missing — never silently reports $0 as a real answer", () => {
    expect(estimateCallCostCents({ telephonyProvider: "twilio", durationSeconds: 0 })).toBeNull();
    expect(estimateCallCostCents({ telephonyProvider: "twilio", durationSeconds: -5 })).toBeNull();
  });

  it("returns null for an unrecognized/missing telephony provider — telephony is the one leg every call has", () => {
    expect(estimateCallCostCents({ telephonyProvider: null, durationSeconds: 60 })).toBeNull();
    expect(estimateCallCostCents({ telephonyProvider: "some-other-provider", durationSeconds: 60 })).toBeNull();
  });

  it("computes telephony + LLM only when STT/TTS are unrecognized or absent", () => {
    const cents = estimateCallCostCents({ telephonyProvider: "twilio", durationSeconds: 60 });
    // 1 minute: twilio 0.0075 + llm flat 0.006 = 0.0135 USD = 1.35 cents
    expect(cents).toBeCloseTo(1.35, 2);
  });

  it("adds STT and TTS legs when both are recognized providers", () => {
    const cents = estimateCallCostCents({
      telephonyProvider: "twilio",
      sttProvider: "deepgram",
      ttsProvider: "cartesia",
      durationSeconds: 60,
    });
    // 1 minute: twilio 0.0075 + llm 0.006 + deepgram 0.005 + cartesia 0.03 = 0.0485 USD = 4.85 cents
    expect(cents).toBeCloseTo(4.85, 2);
  });

  it("scales linearly with duration", () => {
    const oneMinute = estimateCallCostCents({ telephonyProvider: "plivo", durationSeconds: 60 })!;
    const twoMinutes = estimateCallCostCents({ telephonyProvider: "plivo", durationSeconds: 120 })!;
    expect(twoMinutes).toBeCloseTo(oneMinute * 2, 2);
  });

  it("uses exotel's rate for an exotel call", () => {
    const cents = estimateCallCostCents({ telephonyProvider: "exotel", durationSeconds: 60 });
    // 1 minute: exotel 0.014 + llm 0.006 = 0.020 USD = 2.00 cents
    expect(cents).toBeCloseTo(2.0, 2);
  });
});
