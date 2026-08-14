import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVAILABLE_TOOL_NAMES } from "./agent-frame";
import {
  TRANSFER_CAPABLE_PROVIDERS,
  describeTransferBlock,
  isTransferCapableProvider,
  narrowToolsForTransferCapability,
  resolveTransferCapability,
  resolveTransferTarget,
  type TransferBlockedReason,
} from "./handoff";

const capable = { canTransfer: true, reason: null } as const;
const blocked = (reason: TransferBlockedReason) => ({ canTransfer: false, reason } as const);

describe("resolveTransferCapability", () => {
  test("a Twilio call for an org with a transfer number can hand off", () => {
    expect(resolveTransferCapability({ transferNumber: "+18005550199", provider: "twilio", hasOrg: true })).toEqual(
      capable,
    );
  });

  test("Plivo is capable too — it has a wired-up mid-call transfer path", () => {
    expect(resolveTransferCapability({ transferNumber: "+18005550199", provider: "plivo", hasOrg: true })).toEqual(
      capable,
    );
  });

  // The production state on 2026-08-12: all four orgs had humanTransferNumber
  // NULL, so every qualified insurance lead was promised an advisor that no
  // code path could reach.
  test("no transfer number configured blocks the hand-off", () => {
    expect(resolveTransferCapability({ transferNumber: null, provider: "twilio", hasOrg: true })).toEqual(
      blocked("no-transfer-number"),
    );
    expect(resolveTransferCapability({ transferNumber: undefined, provider: "twilio", hasOrg: true })).toEqual(
      blocked("no-transfer-number"),
    );
  });

  test("a blank or whitespace-only number is a misconfiguration, not a target", () => {
    expect(resolveTransferCapability({ transferNumber: "", provider: "twilio", hasOrg: true })).toEqual(
      blocked("no-transfer-number"),
    );
    expect(resolveTransferCapability({ transferNumber: "   ", provider: "twilio", hasOrg: true })).toEqual(
      blocked("no-transfer-number"),
    );
  });

  test("Exotel has no confirmed mid-call transfer API, so it cannot be offered", () => {
    expect(resolveTransferCapability({ transferNumber: "+918005550199", provider: "exotel", hasOrg: true })).toEqual(
      blocked("provider-unsupported"),
    );
  });

  // Text test-chat, the synthetic harness and the preview drawer all run
  // without an org. None of them can transfer and none of them is a
  // misconfigured customer, hence a distinct reason code.
  test("an org-less call reports no-org ahead of any other reason", () => {
    expect(resolveTransferCapability({ transferNumber: null, provider: undefined, hasOrg: false })).toEqual(
      blocked("no-org"),
    );
    expect(resolveTransferCapability({ transferNumber: "+18005550199", provider: "twilio", hasOrg: false })).toEqual(
      blocked("no-org"),
    );
  });

  test("an unknown or missing provider is not assumed capable", () => {
    expect(resolveTransferCapability({ transferNumber: "+18005550199", provider: undefined, hasOrg: true })).toEqual(
      blocked("provider-unsupported"),
    );
    expect(
      resolveTransferCapability({ transferNumber: "+18005550199", provider: "some-new-carrier", hasOrg: true }),
    ).toEqual(blocked("provider-unsupported"));
  });

  test("isTransferCapableProvider matches the exported list", () => {
    for (const provider of TRANSFER_CAPABLE_PROVIDERS) {
      expect(isTransferCapableProvider(provider)).toBe(true);
    }
    expect(isTransferCapableProvider("exotel")).toBe(false);
    expect(isTransferCapableProvider(undefined)).toBe(false);
  });
});

describe("narrowToolsForTransferCapability", () => {
  test("a capable call keeps its list untouched", () => {
    const tools = ["captureField", "transferToHuman", "crmSync"] as const;
    expect(narrowToolsForTransferCapability([...tools], capable)).toEqual([...tools]);
  });

  test("a capable call with no list stays undefined rather than being frozen to today's tools", () => {
    // Materializing here would silently pin AVAILABLE_TOOL_NAMES as it stands
    // now onto every frame-less call, so a tool added later would never reach
    // them. `undefined` must keep meaning "whatever is available".
    expect(narrowToolsForTransferCapability(undefined, capable)).toBeUndefined();
  });

  test("an incapable call loses transferToHuman and nothing else", () => {
    const result = narrowToolsForTransferCapability(
      ["captureField", "transferToHuman", "bookAppointment"],
      blocked("no-transfer-number"),
    );
    expect(result).toEqual(["captureField", "bookAppointment"]);
  });

  // The important case: most production calls have no agent-frame row at all,
  // so `enabledTools` is undefined and every tool is live. A plain filter would
  // have been a no-op exactly where nobody configured anything.
  test("an incapable call with no list gets a materialized list without transferToHuman", () => {
    const result = narrowToolsForTransferCapability(undefined, blocked("no-transfer-number"));
    expect(result).toBeDefined();
    expect(result).not.toContain("transferToHuman");
    expect(result).toHaveLength(AVAILABLE_TOOL_NAMES.length - 1);
    for (const name of AVAILABLE_TOOL_NAMES) {
      if (name !== "transferToHuman") expect(result).toContain(name);
    }
  });

  test("hangUp survives narrowing — ending a call gracefully is never optional", () => {
    const result = narrowToolsForTransferCapability(undefined, blocked("no-org"));
    expect(result).toContain("hangUp");
  });

  test("a list that never had transferToHuman is returned unchanged, not materialized", () => {
    const tools = ["captureField", "setDisposition"] as const;
    expect(narrowToolsForTransferCapability([...tools], blocked("no-transfer-number"))).toEqual([...tools]);
  });

  test("bookAppointment is left intact so a blocked call can still book the callback", () => {
    // The persona's documented fallback when no live advisor is available is a
    // booked callback. Narrowing must not take that away as well, or a blocked
    // call has no recordable outcome at all.
    const result = narrowToolsForTransferCapability(undefined, blocked("no-transfer-number"));
    expect(result).toContain("bookAppointment");
  });
});

/**
 * ADR-114. The per-agent override exists because one org needs different
 * destinations per agent (a renewal agent belongs with retention, a
 * final-expense qualifier with a licensed producer — ADR-081 permits nothing
 * else). These cases are the whole contract.
 */
describe("resolveTransferTarget", () => {
  test("an agent-level number overrides the org number", () => {
    expect(resolveTransferTarget({ agentNumber: "+18005550111", orgNumber: "+18005550199" })).toEqual({
      number: "+18005550111",
      level: "agent",
    });
  });

  test("no agent-level number inherits the org number", () => {
    expect(resolveTransferTarget({ agentNumber: null, orgNumber: "+18005550199" })).toEqual({
      number: "+18005550199",
      level: "org",
    });
    expect(resolveTransferTarget({ agentNumber: undefined, orgNumber: "+18005550199" })).toEqual({
      number: "+18005550199",
      level: "org",
    });
  });

  // The failure mode this guards: an agent whose field was cleared to "" would
  // otherwise shadow a perfectly good org number and silently lose hand-off for
  // that agent only — the hardest version of ADR-105's bug to notice.
  test("a blank agent-level number inherits rather than shadowing the org", () => {
    expect(resolveTransferTarget({ agentNumber: "", orgNumber: "+18005550199" }).level).toBe("org");
    expect(resolveTransferTarget({ agentNumber: "   ", orgNumber: "+18005550199" }).level).toBe("org");
  });

  test("an agent number still applies when the org has none", () => {
    expect(resolveTransferTarget({ agentNumber: "+18005550111", orgNumber: null })).toEqual({
      number: "+18005550111",
      level: "agent",
    });
  });

  test("neither level configured is reported as none, not as an empty string", () => {
    expect(resolveTransferTarget({ agentNumber: null, orgNumber: null })).toEqual({
      number: undefined,
      level: "none",
    });
    expect(resolveTransferTarget({ agentNumber: "  ", orgNumber: "" })).toEqual({
      number: undefined,
      level: "none",
    });
  });

  test("whitespace around a stored number is trimmed before it is dialled", () => {
    expect(resolveTransferTarget({ agentNumber: " +18005550111 ", orgNumber: null }).number).toBe("+18005550111");
  });

  test("its output is exactly what resolveTransferCapability consumes", () => {
    // The two functions are only safe as a pair: capability must be decided on
    // the same resolved value performTransfer dials.
    const target = resolveTransferTarget({ agentNumber: null, orgNumber: null });
    expect(resolveTransferCapability({ transferNumber: target.number, provider: "twilio", hasOrg: true })).toEqual(
      blocked("no-transfer-number"),
    );
  });
});

describe("describeTransferBlock", () => {
  test("every reason has a message, and the fixable one says how to fix it", () => {
    const reasons: TransferBlockedReason[] = ["no-transfer-number", "no-org", "provider-unsupported"];
    for (const reason of reasons) {
      expect(describeTransferBlock(reason).length).toBeGreaterThan(20);
    }
    expect(describeTransferBlock("no-transfer-number")).toContain("humanTransferNumber");
  });
});

/**
 * ADR-105's correctness rests entirely on the tool-offering decision and the
 * transfer-attempting decision being the same decision. `performTransfer` in
 * stream.ts has its own hardcoded provider check and its own "no transfer
 * number" branch; if either drifts from this module, the product goes straight
 * back to promising hand-offs it cannot perform — the defect this ADR exists to
 * remove, re-created invisibly. Asserting against the source text is blunt, but
 * it is the only check that actually fails when someone edits one of the two.
 */
describe("the two transfer decisions cannot silently diverge", () => {
  const streamSource = readFileSync(join(import.meta.dir, "stream.ts"), "utf8");

  test("performTransfer still guards on exactly the providers this module calls capable", () => {
    expect(streamSource).toContain('if (provider !== "twilio" && provider !== "plivo") {');
    expect([...TRANSFER_CAPABLE_PROVIDERS]).toEqual(["twilio", "plivo"]);
  });

  test("performTransfer keeps its own no-transfer-number fallback as defence in depth", () => {
    // Withholding the tool is the fix; this branch is the backstop for the race
    // where an org clears its number mid-call, and must not be deleted as
    // now-unreachable.
    expect(streamSource).toContain("transfer requested but no transfer number configured");
  });

  test("the capability is resolved before the tool list is built", () => {
    const capabilityAt = streamSource.indexOf("transferCapability = resolveTransferCapability(");
    const narrowAt = streamSource.indexOf("enabledToolsOverride = narrowToolsForTransferCapability(");
    expect(capabilityAt).toBeGreaterThan(-1);
    expect(narrowAt).toBeGreaterThan(capabilityAt);
  });

  test("performTransfer dials the single resolved target, not its own second lookup", () => {
    // ADR-114. Before this, `performTransfer` re-read `orgs` for the number
    // while the capability decision used the value resolved at "start" — two
    // independent reads of the same setting. Adding a per-agent override to
    // only one of them would have been ADR-090's defect class again: correct
    // code, no reachable caller. If this fails, that split is back.
    expect(streamSource).toContain("const transferNumber = orgTransferNumber;");
    expect(streamSource).not.toContain("resolveHumanTransferNumber");
  });

  test("the resolved target respects the per-agent override", () => {
    expect(streamSource).toContain("resolveTransferTarget({");
    expect(streamSource).toContain("agentNumber: agentConfig.humanTransferNumber");
  });

  test("the latch blocks caller turns, not just hangUp", () => {
    // ADR-105 F2. If this assertion is what breaks, production call 25's
    // duplicated "You're connected" turn is back.
    expect(streamSource).toContain("[voice] ignoring caller turn: a transferToHuman is already latched");
  });
});
