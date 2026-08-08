import { describe, it, expect } from "bun:test";
import { checkCallingWindow } from "./calling-window";

describe("checkCallingWindow — India (+91)", () => {
  it("allows a call at 10am IST", () => {
    // 2026-07-12T04:30:00Z = 10:00 IST (UTC+5:30)
    const now = new Date("2026-07-12T04:30:00Z");
    const result = checkCallingWindow("+919876543210", now);
    expect(result.allowed).toBe(true);
    expect(result.resolvedTimezone).toBe("Asia/Kolkata");
    expect(result.localHour).toBe(10);
  });

  it("blocks a call at 11pm IST", () => {
    // 2026-07-12T17:30:00Z = 23:00 IST
    const now = new Date("2026-07-12T17:30:00Z");
    const result = checkCallingWindow("+919876543210", now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("TRAI-permitted");
  });

  it("blocks a call at 3am IST — the exact bug this fix closes (was previously " +
    "treated as within the safe NANP fallback window)", () => {
    // 2026-07-12T21:30:00Z (previous day) = 03:00 IST
    const now = new Date("2026-07-11T21:30:00Z");
    const result = checkCallingWindow("+919876543210", now);
    expect(result.allowed).toBe(false);
    expect(result.localHour).toBe(3);
  });

  it("allows exactly at the 9am boundary", () => {
    // 2026-07-12T03:30:00Z = 09:00 IST
    const now = new Date("2026-07-12T03:30:00Z");
    const result = checkCallingWindow("+919876543210", now);
    expect(result.allowed).toBe(true);
  });

  it("blocks exactly at the 9pm boundary (end hour is exclusive)", () => {
    // 2026-07-12T15:30:00Z = 21:00 IST
    const now = new Date("2026-07-12T15:30:00Z");
    const result = checkCallingWindow("+919876543210", now);
    expect(result.allowed).toBe(false);
  });

  it("respects an explicit indiaStartHour/indiaEndHour override", () => {
    const now = new Date("2026-07-12T04:30:00Z"); // 10:00 IST
    const result = checkCallingWindow("+919876543210", now, { indiaStartHour: 11, indiaEndHour: 20 });
    expect(result.allowed).toBe(false);
  });

  it("does not misfire the NANP area-code path for a +91 number", () => {
    const now = new Date("2026-07-12T04:30:00Z");
    const result = checkCallingWindow("+919876543210", now);
    // Must not resolve to any US timezone — confirms the India branch is
    // actually being taken, not falling through to the old fallback.
    expect(result.resolvedTimezone).not.toBe("America/New_York");
  });
});

describe("checkCallingWindow — NANP (+1), unchanged behavior", () => {
  it("still resolves a known area code correctly", () => {
    // 212 = America/New_York. Pick a time that's clearly daytime ET.
    const now = new Date("2026-07-12T16:00:00Z"); // 12:00 ET
    const result = checkCallingWindow("+12125551234", now);
    expect(result.allowed).toBe(true);
    expect(result.resolvedTimezone).toBe("America/New_York");
  });

  it("still falls back to the conservative 11am-9pm ET window for an unrecognized area code", () => {
    const now = new Date("2026-07-12T16:00:00Z"); // 12:00 ET
    const result = checkCallingWindow("+19995551234", now);
    expect(result.allowed).toBe(true);
    expect(result.resolvedTimezone).toBeNull();
  });
});
