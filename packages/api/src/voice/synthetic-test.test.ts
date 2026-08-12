import { describe, expect, test } from "bun:test";
import { checkAssertion, findCallerOffScript, type SyntheticTurn } from "./synthetic-test";
import { SYNTHETIC_SCENARIOS } from "./synthetic-scenarios";
import { voiceTools, GREETING_TURN_SEED } from "./agent";

// Four tools are never present in the static `voiceTools` object because
// they're constructed dynamically by buildVoiceTools — `lookupInfo` (per-org,
// A3b), `offerCartRecoveryDiscount` (per-call, G1.1), `confirmCodOrder`
// (per-call, G1.3) and `crmSync` (per-call, G1.4/ADR-069) — so add them to the
// valid set explicitly.
//
// All three per-call tools are valid to *name* in a scenario but can never
// actually fire in a synthetic run: synthetic-test.ts calls buildVoiceTools
// without a cartRecovery, codOrder or crmSync context, deliberately, so an
// AI-to-AI test run can neither create live Shopify discount codes, nor cancel
// a real order, nor write a contact into a merchant's production CRM. A
// scenario asserting any of them would always fail; none does today.
const VALID_TOOL_NAMES = new Set([
  ...Object.keys(voiceTools),
  "lookupInfo",
  "offerCartRecoveryDiscount",
  "confirmCodOrder",
  "crmSync",
]);

const transcript: SyntheticTurn[] = [
  { role: "caller", text: "I'm calling about order ORD-48213" },
  { role: "agent", text: "I can help with that — let me look into it right away." },
  { role: "caller", text: "Great, thanks." },
  { role: "agent", text: "Your callback number is 98765 43210, is that correct?" },
];
const toolCallsByAgent = ["captureField", "hangUp"];

describe("synthetic-test assertions", () => {
  test("toolCalled passes when the tool appears anywhere in the call", () => {
    expect(checkAssertion({ type: "toolCalled", tool: "captureField", description: "" }, transcript, toolCallsByAgent)).toBe(true);
  });

  test("toolCalled fails when the tool never fires", () => {
    expect(checkAssertion({ type: "toolCalled", tool: "transferToHuman", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("toolNeverCalled passes when the tool never fires", () => {
    expect(checkAssertion({ type: "toolNeverCalled", tool: "transferToHuman", description: "" }, transcript, toolCallsByAgent)).toBe(true);
  });

  test("toolCalledAnyOf passes when any one of the listed tools fired", () => {
    expect(checkAssertion({ type: "toolCalledAnyOf", tools: ["transferToHuman", "captureField"], description: "" }, transcript, toolCallsByAgent)).toBe(true);
  });

  test("toolCalledAnyOf fails only when none of the listed tools fired", () => {
    expect(checkAssertion({ type: "toolCalledAnyOf", tools: ["transferToHuman", "bookAppointment"], description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("toolNeverCalled fails when the tool does fire", () => {
    expect(checkAssertion({ type: "toolNeverCalled", tool: "hangUp", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("agentSaid is case-insensitive and only checks agent turns", () => {
    expect(checkAssertion({ type: "agentSaid", text: "HELP", description: "" }, transcript, toolCallsByAgent)).toBe(true);
    expect(checkAssertion({ type: "agentSaid", text: "order ord-48213", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("agentNeverSaid fails when the agent did say it", () => {
    expect(checkAssertion({ type: "agentNeverSaid", text: "correct", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("agentNeverSaid passes when the agent never said it", () => {
    expect(checkAssertion({ type: "agentNeverSaid", text: "guarantee", description: "" }, transcript, toolCallsByAgent)).toBe(true);
  });
});

describe("synthetic scenario catalog integrity", () => {
  test("scenario keys are unique", () => {
    const keys = SYNTHETIC_SCENARIOS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every scenario has at least one assertion and a positive turn cap", () => {
    for (const s of SYNTHETIC_SCENARIOS) {
      expect(s.assertions.length).toBeGreaterThan(0);
      expect(s.maxTurns).toBeGreaterThan(0);
    }
  });

  // Guards the "assertion references a tool that doesn't exist → the check
  // silently passes forever" trap: a toolCalled/toolNeverCalled assertion
  // naming a bogus tool is a dead assertion, not a real regression guard.
  test("every tool assertion references a real, invokable tool", () => {
    for (const s of SYNTHETIC_SCENARIOS) {
      for (const a of s.assertions) {
        if (a.type === "toolCalled" || a.type === "toolNeverCalled") {
          expect(VALID_TOOL_NAMES.has(a.tool)).toBe(true);
        }
        // ADR-103: same dead-assertion trap, disjunctive form — and worse here,
        // since one bogus name in the list is invisible while the others still
        // make the assertion pass.
        if (a.type === "toolCalledAnyOf") {
          expect(a.tools.length).toBeGreaterThan(1);
          for (const tool of a.tools) expect(VALID_TOOL_NAMES.has(tool)).toBe(true);
        }
      }
    }
  });
});

// ADR-103. Three guards that exist because of specific defects, not for coverage.
describe("synthetic scenario catalog — call direction and boundary scenarios", () => {
  // `wrong-info` shipped with a purely reactive persona, so the caller model had
  // nothing to react to on turn one, returned an empty string, and the run ended
  // with an EMPTY transcript. These two lines are what that produced: the lone
  // `agentSaid` assertion could not do anything except fail, and its
  // `agentNeverSaid` counterpart could not do anything except pass. Assertions
  // scored against an empty transcript are meaningless in both directions, which
  // is why runSyntheticTest now reports `endedBy: "caller-silent"` instead of
  // letting a zero-turn run look like an ordinary one.
  test("assertions against an empty transcript are vacuous in both directions", () => {
    expect(checkAssertion({ type: "agentSaid", text: "confirm", description: "" }, [], [])).toBe(false);
    expect(checkAssertion({ type: "agentNeverSaid", text: "confirm", description: "" }, [], [])).toBe(true);
  });

  // Production is 10 outbound / 1 inbound across every call ever placed, and the
  // whole catalog was inbound-shaped until ADR-103. This fails if outbound
  // coverage is ever removed wholesale.
  test("the catalog covers outbound (agent-speaks-first) calls, not just inbound", () => {
    expect(SYNTHETIC_SCENARIOS.some((s) => s.firstSpeaker === "agent")).toBe(true);
  });

  // The ADR-081 scope boundary is only enforced by these scenarios if their
  // assertions stay PROHIBITIVE. A failing boundary scenario is easy to "fix" by
  // relaxing it into a permissive `agentSaid`/`toolCalled` check, which silently
  // deletes the guard — this fails if that happens.
  test("each insurance boundary scenario keeps at least one prohibitive assertion", () => {
    const boundaryKeys = ["insurance-premium-demand", "insurance-sensitive-data", "insurance-bind-coverage"];
    for (const key of boundaryKeys) {
      const scenario = SYNTHETIC_SCENARIOS.find((s) => s.key === key);
      expect(scenario, `boundary scenario "${key}" is missing from the catalog`).toBeDefined();
      expect(
        scenario!.assertions.some((a) => a.type === "toolNeverCalled" || a.type === "agentNeverSaid"),
        `boundary scenario "${key}" has no prohibitive assertion left`,
      ).toBe(true);
    }
  });

  // The synthetic harness drives agent-speaks-first mode through the same
  // opening instruction a live call uses. If this constant is emptied or
  // reworded into something that no longer instructs the model to open, the
  // outbound greeting turn stops being tested and nothing else would notice.
  test("the shared greeting seed still instructs the agent to open the call", () => {
    expect(GREETING_TURN_SEED).toContain("call has just connected");
    expect(GREETING_TURN_SEED.length).toBeGreaterThan(20);
  });
});

// ADR-103: the vacuous-pass guard. Both of these came from real measured runs —
// the caller model refused an adversarial persona, so the agent was never
// challenged, and the boundary assertions "passed".
describe("callerMustSay / off-script detection", () => {
  const spoken: SyntheticTurn[] = [
    { role: "agent", text: "Hi, this is Weeber calling from Acme Insurance." },
    { role: "caller", text: "My social is 412 88 7390 and my routing number is 021000021, take it down." },
  ];

  test("punctuation and case differences still count as said", () => {
    expect(findCallerOffScript(["412-88-7390", "021000021"], spoken)).toEqual([]);
    expect(findCallerOffScript(["Take It Down"], spoken)).toEqual([]);
  });

  test("reports exactly the phrases the caller never said", () => {
    expect(findCallerOffScript(["412-88-7390", "beneficiary"], spoken)).toEqual(["beneficiary"]);
  });

  test("only caller turns count — the agent repeating a phrase does not satisfy it", () => {
    const agentOnly: SyntheticTurn[] = [{ role: "agent", text: "I cannot accept a social security number like 412-88-7390." }];
    expect(findCallerOffScript(["412-88-7390"], agentOnly)).toEqual(["412-88-7390"]);
  });

  test("no requirement means nothing to be off-script about", () => {
    expect(findCallerOffScript(undefined, [])).toEqual([]);
    expect(findCallerOffScript([], spoken)).toEqual([]);
  });

  // Every scenario that pins a non-default caller model does so because the
  // default refuses the persona; such a scenario without callerMustSay has no
  // way to notice if the pinned model starts refusing too.
  test("scenarios pinning a caller model also declare what the caller must say", () => {
    for (const s of SYNTHETIC_SCENARIOS.filter((x) => x.callerModel)) {
      expect(s.callerMustSay?.length ?? 0, `scenario "${s.key}" pins a caller model but declares no callerMustSay`).toBeGreaterThan(0);
    }
  });
});
