import { describe, it, expect } from "bun:test";
import { checkCallingWindow } from "../calling-window";

describe("mini-TCPA state overrides (FL/OK/WA cap at 8pm, not federal 9pm) — Tier 0 #5", () => {
  it("blocks a Florida (305) number at 8:30pm local — allowed under federal TCPA, blocked by FL's mini-TCPA", () => {
    // 305 -> America/New_York. 2026-07-12T00:30:00Z = 8:30pm ET on 2026-07-11.
    const now = new Date("2026-07-12T00:30:00Z");
    const result = checkCallingWindow("+13055551234", now);
    expect(result.allowed).toBe(false);
    expect(result.localHour).toBe(20);
    expect(result.reason).toContain("FL mini-TCPA");
  });

  it("allows the same Florida number at 7:30pm local — still within the 8pm cap", () => {
    const now = new Date("2026-07-11T23:30:00Z"); // 7:30pm ET
    const result = checkCallingWindow("+13055551234", now);
    expect(result.allowed).toBe(true);
  });

  it("allows a non-mini-TCPA number (212, NY) at 8:30pm local — federal 9pm baseline applies", () => {
    const now = new Date("2026-07-12T00:30:00Z"); // 8:30pm ET
    const result = checkCallingWindow("+12125551234", now);
    expect(result.allowed).toBe(true);
  });

  it("blocks an Oklahoma (405) number at 8:30pm local (Central)", () => {
    // 405 -> America/Chicago. 2026-07-12T01:30:00Z = 8:30pm CT.
    const now = new Date("2026-07-12T01:30:00Z");
    const result = checkCallingWindow("+14055551234", now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("OK mini-TCPA");
  });

  it("blocks a Washington (206) number at 8:30pm local (Pacific)", () => {
    // 206 -> America/Los_Angeles. 2026-07-12T03:30:00Z = 8:30pm PT.
    const now = new Date("2026-07-12T03:30:00Z");
    const result = checkCallingWindow("+12065551234", now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("WA mini-TCPA");
  });

  it("an explicit endHour override always wins over the mini-TCPA default", () => {
    const now = new Date("2026-07-12T00:30:00Z"); // 8:30pm ET, FL number
    const result = checkCallingWindow("+13055551234", now, { endHour: 22 });
    expect(result.allowed).toBe(true);
  });
});
