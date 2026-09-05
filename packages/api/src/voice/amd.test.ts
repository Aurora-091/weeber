import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AMD_MACHINE_ANSWERS,
  shouldHijackLiveCallForAmd,
  shouldRequestTwilioAmd,
} from "./amd";

describe("shouldRequestTwilioAmd", () => {
  it("opts in for a NANP E.164 number — US voicemail is what AMD was built for", () => {
    expect(shouldRequestTwilioAmd("+15557776666")).toBe(true);
    expect(shouldRequestTwilioAmd("+1 (555) 777-6666")).toBe(true);
  });

  it("stays off for India PSTN — the 2026-09-05 false-positive destination", () => {
    expect(shouldRequestTwilioAmd("+917499291834")).toBe(false);
    expect(shouldRequestTwilioAmd("+91 74992 91834")).toBe(false);
  });

  it("stays off for anything that is not +1 plus ten digits", () => {
    expect(shouldRequestTwilioAmd("+447911123456")).toBe(false);
    expect(shouldRequestTwilioAmd("15557776666")).toBe(false);
  });
});

describe("shouldHijackLiveCallForAmd", () => {
  it("redirects a machine result only when the caller has not spoken", () => {
    for (const answeredBy of AMD_MACHINE_ANSWERS) {
      expect(shouldHijackLiveCallForAmd({ answeredBy, callerHasSpoken: false })).toBe(true);
      expect(shouldHijackLiveCallForAmd({ answeredBy, callerHasSpoken: true })).toBe(false);
    }
  });

  it("never hijacks a human or unknown classification", () => {
    expect(shouldHijackLiveCallForAmd({ answeredBy: "human", callerHasSpoken: false })).toBe(false);
    expect(shouldHijackLiveCallForAmd({ answeredBy: "unknown", callerHasSpoken: false })).toBe(false);
    expect(shouldHijackLiveCallForAmd({ answeredBy: "", callerHasSpoken: false })).toBe(false);
  });
});

describe("dashboard test calls never request AMD (ADR-123)", () => {
  it("both test-call-phone handlers pass amd: false", () => {
    const appRoutes = readFileSync(join(import.meta.dir, "../app/routes.ts"), "utf8");
    const voiceRoutes = readFileSync(join(import.meta.dir, "routes.ts"), "utf8");
    expect(appRoutes).toContain("placeOutboundCall({ orgId, to: phone, agentKey: templateKey, amd: false })");
    expect(voiceRoutes).toContain("placeOutboundCall({ orgId, to: phone, agentKey: templateKey, amd: false })");
  });

  it("the AMD callback refuses to hijack once a caller-role transcript exists", () => {
    const voiceRoutes = readFileSync(join(import.meta.dir, "routes.ts"), "utf8");
    expect(voiceRoutes).toContain("shouldHijackLiveCallForAmd({ answeredBy, callerHasSpoken })");
    expect(voiceRoutes).toContain('eq(transcripts.role, "caller")');
  });
});
