import { describe, it, expect } from "bun:test";
import { checkCallingWindow } from "./calling-window";
import { checkOutboundCallCompliance } from "./index";
import { createMemoryDncAdapter, createMemoryCallLogAdapter, createMemoryConsentAdapter } from "./adapters/memory";
import { withDisclosure, isDisclosureEnabled } from "./consent";
import { isHipaaMode, assertHipaaPreflight } from "./hipaa";
import { purgeExpiredData, eraseCallerData, getRetentionDays } from "./gdpr";
import { syncNationalDncRegistry, noopNationalRegistryFetcher } from "./national-dnc";

describe("calling-window", () => {
  it("allows a call within the resolved window for a known area code", () => {
    // 212 = America/New_York. Pick a time known to be 2pm ET.
    const noonUtcAsEtAfternoon = new Date("2026-07-04T18:00:00Z"); // 2pm ET (summer, UTC-4)
    const result = checkCallingWindow("+12125550100", noonUtcAsEtAfternoon);
    expect(result.resolvedTimezone).toBe("America/New_York");
    expect(result.allowed).toBe(true);
  });

  it("blocks a call outside the window for a known area code", () => {
    const threeAmEt = new Date("2026-07-04T07:00:00Z"); // 3am ET
    const result = checkCallingWindow("+12125550100", threeAmEt);
    expect(result.allowed).toBe(false);
  });

  it("falls back to the safe window for an unresolved area code", () => {
    const result = checkCallingWindow("+19995550100", new Date());
    expect(result.resolvedTimezone).toBeNull();
  });
});

describe("dnc (memory adapter)", () => {
  it("blocks a listed number and allows an unlisted one", async () => {
    const dnc = createMemoryDncAdapter();
    await dnc.add({ phoneNumber: "+15550001111", source: "manual", addedAt: new Date() });

    const blocked = await checkOutboundCallCompliance("+15550001111", dnc);
    expect(blocked.allowed).toBe(false);

    // 212 = America/New_York, a resolvable area code — override the window
    // wide open to isolate "DNC check passes" from calling-window timing.
    const allowed = await checkOutboundCallCompliance("+12125550100", dnc, { startHour: 0, endHour: 24 });
    expect(allowed.allowed).toBe(true);
  });
});

describe("consent ledger — Global Compliance Engine Tier 0 #6 (memory adapter)", () => {
  it("hasConsent is false with no grant on record", async () => {
    const consent = createMemoryConsentAdapter();
    expect(await consent.hasConsent("+15550001111", "marketing")).toBe(false);
  });

  it("hasConsent is true after a grant for that exact purpose", async () => {
    const consent = createMemoryConsentAdapter();
    await consent.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    expect(await consent.hasConsent("+15550001111", "marketing")).toBe(true);
  });

  it("consent for one purpose never satisfies a check for a different purpose", async () => {
    const consent = createMemoryConsentAdapter();
    await consent.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    expect(await consent.hasConsent("+15550001111", "underwriting")).toBe(false);
  });

  it("withdrawal stops hasConsent from returning true for that purpose going forward", async () => {
    const consent = createMemoryConsentAdapter();
    await consent.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    expect(await consent.hasConsent("+15550001111", "marketing")).toBe(true);

    await consent.withdraw("+15550001111", "marketing");
    expect(await consent.hasConsent("+15550001111", "marketing")).toBe(false);
  });

  it("withdrawing one purpose does not affect a different purpose's active grant", async () => {
    const consent = createMemoryConsentAdapter();
    await consent.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    await consent.grant({
      dataPrincipal: "+15550001111",
      purpose: "service",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "order placement",
    });

    await consent.withdraw("+15550001111", "marketing");
    expect(await consent.hasConsent("+15550001111", "marketing")).toBe(false);
    expect(await consent.hasConsent("+15550001111", "service")).toBe(true);
  });

  it("an expired grant does not satisfy hasConsent", async () => {
    const consent = createMemoryConsentAdapter();
    await consent.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() - 500),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    expect(await consent.hasConsent("+15550001111", "marketing")).toBe(false);
  });

  it("re-granting after a withdrawal restores hasConsent (ledger keeps both rows, doesn't overwrite)", async () => {
    const consent = createMemoryConsentAdapter();
    await consent.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    await consent.withdraw("+15550001111", "marketing");
    expect(await consent.hasConsent("+15550001111", "marketing")).toBe(false);

    await consent.grant({
      dataPrincipal: "+15550001111",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "web",
      source: "re-opted-in via settings page",
    });
    expect(await consent.hasConsent("+15550001111", "marketing")).toBe(true);

    const history = await consent.listForPrincipal("+15550001111");
    expect(history.length).toBe(2);
  });

  it("checkOutboundCallCompliance's consent check is opt-in — omitting it keeps today's DNC+window-only behavior", async () => {
    const dnc = createMemoryDncAdapter();
    const result = await checkOutboundCallCompliance("+12125550100", dnc, { startHour: 0, endHour: 24 });
    expect(result.allowed).toBe(true);
  });

  it("checkOutboundCallCompliance blocks a dial with no consent for the given purpose when wired", async () => {
    const dnc = createMemoryDncAdapter();
    const consent = createMemoryConsentAdapter();
    const result = await checkOutboundCallCompliance(
      "+12125550100",
      dnc,
      { startHour: 0, endHour: 24 },
      { adapter: consent, purpose: "marketing" },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.failedCheck).toBe("consent");
  });

  it("checkOutboundCallCompliance allows a dial once the purpose-matched consent is granted", async () => {
    const dnc = createMemoryDncAdapter();
    const consent = createMemoryConsentAdapter();
    await consent.grant({
      dataPrincipal: "+12125550100",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    const result = await checkOutboundCallCompliance(
      "+12125550100",
      dnc,
      { startHour: 0, endHour: 24 },
      { adapter: consent, purpose: "marketing" },
    );
    expect(result.allowed).toBe(true);
  });

  it("DNC is still checked first even when a consent check is wired — DNC has no bypass, ever", async () => {
    const dnc = createMemoryDncAdapter();
    await dnc.add({ phoneNumber: "+12125550100", source: "manual", addedAt: new Date() });
    const consent = createMemoryConsentAdapter();
    await consent.grant({
      dataPrincipal: "+12125550100",
      purpose: "marketing",
      granted: true,
      grantedAt: new Date(),
      version: "v1",
      channel: "shopify",
      source: "checkout consent checkbox",
    });
    const result = await checkOutboundCallCompliance(
      "+12125550100",
      dnc,
      { startHour: 0, endHour: 24 },
      { adapter: consent, purpose: "marketing" },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.failedCheck).toBe("dnc");
  });
});

describe("consent", () => {
  it("is enabled by default and injects the disclosure line", () => {
    expect(isDisclosureEnabled()).toBe(true);
    const persona = withDisclosure("You are a helpful assistant.");
    expect(persona).toContain("may be recorded");
  });

  it("can be disabled via explicit options", () => {
    const persona = withDisclosure("You are a helpful assistant.", { enabled: false });
    expect(persona).toBe("You are a helpful assistant.");
  });
});

describe("hipaa", () => {
  it("does not throw when disabled", () => {
    expect(() => assertHipaaPreflight({ enabled: false })).not.toThrow();
  });

  it("throws when enabled without BAA confirmation", () => {
    expect(() => assertHipaaPreflight({ enabled: true, baaConfirmed: false })).toThrow();
  });

  it("does not throw when enabled with BAA confirmation", () => {
    expect(() => assertHipaaPreflight({ enabled: true, baaConfirmed: true })).not.toThrow();
  });

  it("reports mode correctly", () => {
    expect(isHipaaMode({ enabled: true })).toBe(true);
    expect(isHipaaMode({ enabled: false })).toBe(false);
  });
});

describe("gdpr (memory adapter)", () => {
  it("purges calls older than the retention window", async () => {
    const log = createMemoryCallLogAdapter();
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const recent = new Date();
    log.seed([
      { id: "1", fromNumber: "+1", toNumber: "+2", startedAt: old },
      { id: "2", fromNumber: "+1", toNumber: "+2", startedAt: recent },
    ]);

    const result = await purgeExpiredData(log, { retentionDays: 90 });
    expect(result.callsDeleted).toBe(1);

    const remaining = await log.findCallsStartedBefore(new Date(Date.now() + 1000));
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.id).toBe("2");
  });

  it("erases all data for a phone number on request", async () => {
    const log = createMemoryCallLogAdapter();
    log.seed([
      { id: "1", fromNumber: "+15551112222", toNumber: "+2", startedAt: new Date() },
      { id: "2", fromNumber: "+3", toNumber: "+15551112222", startedAt: new Date() },
      { id: "3", fromNumber: "+3", toNumber: "+4", startedAt: new Date() },
    ]);

    const result = await eraseCallerData(log, "+15551112222");
    expect(result.callsDeleted).toBe(2);

    const remaining = await log.findCallsByPhoneNumber("+15551112222");
    expect(remaining.length).toBe(0);
  });

  it("defaults retention to 90 days", () => {
    expect(getRetentionDays()).toBe(90);
  });
});

describe("national-dnc", () => {
  it("noop fetcher syncs zero numbers without erroring", async () => {
    const dnc = createMemoryDncAdapter();
    const result = await syncNationalDncRegistry(dnc, noopNationalRegistryFetcher);
    expect(result.numbersSynced).toBe(0);
  });

  it("syncs a real fetcher's numbers into the DNC list with the correct source", async () => {
    const dnc = createMemoryDncAdapter();
    const fetcher = { fetchRegisteredNumbers: async () => ["+15551110000", "+15551110001"] };
    const result = await syncNationalDncRegistry(dnc, fetcher);
    expect(result.numbersSynced).toBe(2);

    const list = await dnc.list();
    expect(list.length).toBe(2);
    expect(list.every((entry) => entry.source === "national-registry")).toBe(true);
  });
});
