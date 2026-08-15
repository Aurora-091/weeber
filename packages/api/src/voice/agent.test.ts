import { describe, it, expect, beforeEach } from "bun:test";
import { buildKnownFactsBlock, buildWorkflowContextBlock, resolveAgentConfig, toTurnTokenUsage } from "./agent";
import { INSURANCE_GREETINGS } from "./insurance-greetings";

describe("toTurnTokenUsage", () => {
  it("extracts cache-read tokens from the AI SDK's inputTokenDetails shape (Groq/OpenAI automatic caching)", () => {
    const usage = toTurnTokenUsage("groq/llama-3.3-70b-versatile", {
      inputTokens: 2000,
      outputTokens: 40,
      inputTokenDetails: { textTokens: 500, cacheReadTokens: 1500 },
    });
    expect(usage).toEqual({
      model: "groq/llama-3.3-70b-versatile",
      inputTokens: 2000,
      outputTokens: 40,
      cachedInputTokens: 1500,
    });
  });

  it("falls back to a cachedTokens field when a provider names it differently", () => {
    const usage = toTurnTokenUsage("gateway/openai/gpt-5.4-mini", {
      inputTokens: 1800,
      outputTokens: 30,
      inputTokenDetails: { cachedTokens: 1200 },
    });
    expect(usage.cachedInputTokens).toBe(1200);
  });

  it("never throws on a provider that reports nothing, or on undefined usage", () => {
    expect(toTurnTokenUsage("m", undefined)).toEqual({
      model: "m",
      inputTokens: undefined,
      outputTokens: undefined,
      cachedInputTokens: undefined,
    });
    expect(toTurnTokenUsage("m", {})).toEqual({
      model: "m",
      inputTokens: undefined,
      outputTokens: undefined,
      cachedInputTokens: undefined,
    });
  });
});

describe("buildKnownFactsBlock", () => {
  it("returns an empty string when there is no captured state", () => {
    expect(buildKnownFactsBlock(undefined)).toBe("");
    expect(buildKnownFactsBlock({})).toBe("");
  });

  it("renders a single captured fact as a labeled block", () => {
    const block = buildKnownFactsBlock({ email: "a@b.com" });
    expect(block).toContain("Known facts about this call");
    expect(block).toContain("do not ask for these again");
    expect(block).toContain("- email: a@b.com");
  });

  it("renders multiple captured facts, one per line", () => {
    const block = buildKnownFactsBlock({
      email: "a@b.com",
      order_id: "ORD-123",
      caller_name: "Jamie",
    });
    expect(block).toContain("- email: a@b.com");
    expect(block).toContain("- order_id: ORD-123");
    expect(block).toContain("- caller_name: Jamie");
  });

  it("does not mutate its input", () => {
    const state = { email: "a@b.com" };
    buildKnownFactsBlock(state);
    expect(state).toEqual({ email: "a@b.com" });
  });
});

import { mock } from "bun:test";

let mockOrgConfig: any = null;
let mockTemplate: any = null;

mock.module("../database", () => {
  return {
    db: {
      select: () => ({
        from: (table: any) => ({
          where: () => ({
            limit: () => {
              if (table && table.templateKey) {
                // orgAgentConfigs query
                return mockOrgConfig ? [mockOrgConfig] : [];
              }
              // agentTemplates query
              return mockTemplate ? [mockTemplate] : [];
            }
          })
        })
      })
    }
  };
});

import { resolvePersona } from "./agent";

describe("resolvePersona", () => {
  beforeEach(() => {
    mockOrgConfig = null;
    mockTemplate = null;
  });

  it("resolves org override when available", async () => {
    mockOrgConfig = { personaPrompt: "Org Custom Prompt" };
    mockTemplate = { defaultPersonaPrompt: "Template Prompt" };

    const persona = await resolvePersona({
      explicitPersona: "shopify-cart-recovery",
      orgId: "org-123",
      templateKey: "shopify-cart-recovery"
    });

    expect(persona).toContain("Org Custom Prompt");
  });

  it("resolves template default when no org override exists", async () => {
    mockOrgConfig = null;
    mockTemplate = { defaultPersonaPrompt: "Template Prompt" };

    const persona = await resolvePersona({
      explicitPersona: "shopify-cart-recovery",
      orgId: "org-123",
      templateKey: "shopify-cart-recovery"
    });

    expect(persona).toContain("Template Prompt");
  });

  it("resolves explicit persona prompt if it is a raw prompt", async () => {
    const persona = await resolvePersona({
      explicitPersona: "You are a custom raw prompt.",
      orgId: "org-123"
    });

    expect(persona).toContain("You are a custom raw prompt.");
  });

  it("falls back to default persona if no match is found", async () => {
    const persona = await resolvePersona({});
    expect(persona).toContain("answering a live phone call on behalf of");
  });

  // The default persona is what a caller actually hears whenever no org or
  // template persona applies — and AGENT_PERSONAS is unset in production, so
  // this IS the live fallback, not a theoretical one. It used to open with
  // "You are OpenVent" and then pitch the platform down the phone. A caller
  // dialing a clinic should never hear the name of the vendor behind the
  // software, under either brand. Asserting the absence, not a new brand
  // string, is what stops this regressing the next time someone rebrands.
  it("never names the platform vendor in the default persona", async () => {
    const persona = (await resolvePersona({})).toLowerCase();
    expect(persona).not.toContain("openvent");
    expect(persona).not.toContain("weeber");
  });

  it("appends call-control/guardrail instructions to every resolved persona, regardless of source", async () => {
    mockOrgConfig = { personaPrompt: "Org Custom Prompt" };
    const withOrgOverride = await resolvePersona({
      explicitPersona: "shopify-cart-recovery",
      orgId: "org-123",
      templateKey: "shopify-cart-recovery",
    });
    expect(withOrgOverride).toContain("hangUp");
    expect(withOrgOverride).toContain("transferToHuman");
    expect(withOrgOverride).toContain("flagGuardrailEvent");
    expect(withOrgOverride).toContain("prompt-injection");

    const fallbackDefault = await resolvePersona({});
    expect(fallbackDefault).toContain("hangUp");
    expect(fallbackDefault).toContain("topic-boundary");
  });
});

describe("resolveAgentConfig — literalGreetingTemplate (latency fix, 2026-07-16)", () => {
  beforeEach(() => {
    mockOrgConfig = null;
    mockTemplate = null;
  });

  it("surfaces the template's literalGreetingTemplate when the org has no persona override", async () => {
    mockOrgConfig = { personaPrompt: null, name: "Priya" };
    mockTemplate = {
      defaultPersonaPrompt: "Template Prompt",
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling from {{merchant_name}}.",
    };

    const config = await resolveAgentConfig({
      explicitPersona: "shopify-cod-confirmation",
      orgId: "org-123",
      templateKey: "shopify-cod-confirmation",
    });

    expect(config.literalGreetingTemplate).toBe("Hello, this is {{agent_name}} calling from {{merchant_name}}.");
    expect(config.agentName).toBe("Priya");
  });

  it("omits literalGreetingTemplate when the org has customized its own personaPrompt", async () => {
    mockOrgConfig = { personaPrompt: "This merchant wrote their own entire script." };
    mockTemplate = {
      defaultPersonaPrompt: "Template Prompt",
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling from {{merchant_name}}.",
    };

    const config = await resolveAgentConfig({
      explicitPersona: "shopify-cod-confirmation",
      orgId: "org-123",
      templateKey: "shopify-cod-confirmation",
    });

    // A customized persona may have rewritten the opener entirely — speaking
    // the template's fixed line verbatim would be wrong regardless of latency,
    // so this must fall back to the existing LLM-generated greeting.
    expect(config.literalGreetingTemplate).toBeUndefined();
  });

  it("surfaces literalGreetingTemplate from the template even with no org config row at all", async () => {
    mockOrgConfig = null;
    mockTemplate = {
      defaultPersonaPrompt: "Template Prompt",
      literalGreetingTemplate: "Hi, this is {{agent_name}} calling from {{merchant_name}}.",
    };

    const config = await resolveAgentConfig({
      explicitPersona: "shopify-cart-recovery",
      orgId: "org-123",
      templateKey: "shopify-cart-recovery",
    });

    expect(config.literalGreetingTemplate).toBe("Hi, this is {{agent_name}} calling from {{merchant_name}}.");
  });

  it("is undefined when the template has none set", async () => {
    mockOrgConfig = null;
    mockTemplate = { defaultPersonaPrompt: "Template Prompt", literalGreetingTemplate: null };

    const config = await resolveAgentConfig({
      explicitPersona: "shopify-feedback",
      orgId: "org-123",
      templateKey: "shopify-feedback",
    });

    expect(config.literalGreetingTemplate).toBeUndefined();
  });

  // Language-localized canned greeting (2026-07-19): for an insurance template
  // configured in a non-English language, the canned greeting must be the
  // AUDITED translation, never the English DB line through a non-English voice.
  it("keeps the English literalGreetingTemplate for an English insurance agent", async () => {
    mockOrgConfig = { personaPrompt: null, name: "Priya", language: "en" };
    mockTemplate = {
      defaultPersonaPrompt: "Template Prompt",
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling from {{company_name}}.",
    };

    const config = await resolveAgentConfig({
      explicitPersona: "insurance-policy-renewal",
      orgId: "org-123",
      templateKey: "insurance-policy-renewal",
    });

    expect(config.literalGreetingTemplate).toBe("Hello, this is {{agent_name}} calling from {{company_name}}.");
  });

  it("uses the audited Hindi greeting (not the English line) for a Hindi insurance agent", async () => {
    mockOrgConfig = { personaPrompt: null, name: "Priya", language: "hi" };
    mockTemplate = {
      defaultPersonaPrompt: "Template Prompt",
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling from {{company_name}}.",
    };

    const config = await resolveAgentConfig({
      explicitPersona: "insurance-policy-renewal",
      orgId: "org-123",
      templateKey: "insurance-policy-renewal",
    });

    expect(config.literalGreetingTemplate).toBe(INSURANCE_GREETINGS["insurance-policy-renewal"]!.hi!);
    expect(config.literalGreetingTemplate).not.toContain("Hello, this is");
  });

  it("uses the audited Hinglish greeting for a Hinglish insurance agent", async () => {
    mockOrgConfig = { personaPrompt: null, name: "Priya", language: "hinglish" };
    mockTemplate = {
      defaultPersonaPrompt: "Template Prompt",
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling from {{company_name}}.",
    };

    const config = await resolveAgentConfig({
      explicitPersona: "insurance-post-sale-welcome",
      orgId: "org-123",
      templateKey: "insurance-post-sale-welcome",
    });

    expect(config.literalGreetingTemplate).toBe(INSURANCE_GREETINGS["insurance-post-sale-welcome"]!.hinglish!);
  });

  it("suppresses the canned greeting for a language with no audited translation (LLM greets instead)", async () => {
    mockOrgConfig = { personaPrompt: null, name: "Priya", language: "mr" };
    mockTemplate = {
      defaultPersonaPrompt: "Template Prompt",
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling from {{company_name}}.",
    };

    const config = await resolveAgentConfig({
      explicitPersona: "insurance-policy-renewal",
      orgId: "org-123",
      templateKey: "insurance-policy-renewal",
    });

    expect(config.literalGreetingTemplate).toBeUndefined();
  });
});

import { buildPreviewAgentConfig } from "./agent";

describe("buildPreviewAgentConfig — Preview drawer's live/unsaved-form path", () => {
  beforeEach(() => {
    mockOrgConfig = null;
    mockTemplate = null;
  });

  it("builds the system prompt straight from the override, not from any saved DB row", async () => {
    const config = await buildPreviewAgentConfig("shopify-cart-recovery", {
      personaPrompt: "You are testing an in-progress edit that was never saved.",
      name: "Aria",
      toneStyle: "friendly",
      greetingLine: "Hey there, quick call about your cart!",
    });

    expect(config.systemPrompt).toContain("You are testing an in-progress edit that was never saved.");
    expect(config.systemPrompt).toContain("Your name is Aria");
    expect(config.systemPrompt).toContain("friendly tone");
    expect(config.systemPrompt).toContain("quick call about your cart");
    // Never touched the DB for persona text since personaPrompt was provided.
    expect(mockTemplate).toBeNull();
  });

  it("falls back to the template's default persona when override.personaPrompt is empty — not an empty prompt", async () => {
    mockTemplate = { defaultPersonaPrompt: "Template default persona text." };

    const config = await buildPreviewAgentConfig("shopify-cart-recovery", {
      personaPrompt: undefined,
      name: "Aria",
    });

    expect(config.systemPrompt).toContain("Template default persona text.");
  });

  it("carries voice/llm/tools/language straight through from the override, unmerged with any saved row", async () => {
    const config = await buildPreviewAgentConfig("shopify-cart-recovery", {
      personaPrompt: "test",
      voiceProvider: "elevenlabs",
      voiceId: "voice-abc",
      llmProvider: "groq",
      llmModel: "llama-3.3-70b-versatile",
      toolsEnabled: ["bookAppointment", "hangUp"],
      language: "hi",
    });

    expect(config.ttsProvider).toBe("elevenlabs");
    expect(config.voiceId).toBe("voice-abc");
    expect(config.llmProvider).toBe("groq");
    expect(config.llmModel).toBe("llama-3.3-70b-versatile");
    expect(config.enabledTools).toEqual(["bookAppointment", "hangUp"]);
    expect(config.language).toBe("hi");
  });

  it("appends call-control/guardrail instructions to the preview prompt, same as a real saved config would get", async () => {
    const config = await buildPreviewAgentConfig("shopify-cart-recovery", {
      personaPrompt: "test persona",
    });
    expect(config.systemPrompt).toContain("hangUp");
    expect(config.systemPrompt).toContain("transferToHuman");
  });

  // Regression test for the 2026-07-15 production bug: a real phone test
  // call kept getting "tool call validation failed ... captureField ...
  // not in request.tools" from Groq, because the call-control prompt
  // unconditionally told the model to call captureField/transferToHuman/
  // flagGuardrailEvent even when an agent's toolsEnabled list excluded
  // them — a strict-tool-calling provider rejects the whole turn outright
  // when the model attempts a tool name that isn't in `tools`.
  it("never instructs the model to call a tool that isn't in toolsEnabled (strict-tool-calling providers reject the whole turn otherwise)", async () => {
    const narrowed = await buildPreviewAgentConfig("shopify-cart-recovery", {
      personaPrompt: "test persona",
      toolsEnabled: ["hangUp", "setDisposition"],
    });
    expect(narrowed.systemPrompt).not.toContain("captureField");
    expect(narrowed.systemPrompt).not.toContain("transferToHuman");
    expect(narrowed.systemPrompt).not.toContain("flagGuardrailEvent");
    // hangUp is always force-included by buildVoiceTools regardless of
    // toolsEnabled, so it's always safe to keep referencing it.
    expect(narrowed.systemPrompt).toContain("hangUp");
  });

  it("still instructs the model to use captureField/transferToHuman/flagGuardrailEvent when toolsEnabled is undefined (every tool available, unchanged default)", async () => {
    const allTools = await buildPreviewAgentConfig("shopify-cart-recovery", {
      personaPrompt: "test persona",
    });
    expect(allTools.systemPrompt).toContain("captureField");
    expect(allTools.systemPrompt).toContain("transferToHuman");
    expect(allTools.systemPrompt).toContain("flagGuardrailEvent");
  });

  it("respects toolsEnabled narrowing for org-saved configs too (resolvePersona/resolveAgentConfig path), not just the preview override path", async () => {
    mockOrgConfig = { personaPrompt: "Org Custom Prompt", toolsEnabled: ["hangUp"] };
    const resolved = await resolveAgentConfig({ orgId: "org-123", templateKey: "shopify-cart-recovery" });
    expect(resolved.systemPrompt).not.toContain("captureField");
    expect(resolved.systemPrompt).not.toContain("transferToHuman");
    expect(resolved.systemPrompt).not.toContain("flagGuardrailEvent");
  });
});

import { withFillerTimer, withToolTimeout, TOOL_CALL_FILLER_THRESHOLD_MS, buildVoiceTools, voiceTools } from "./agent";

describe("withFillerTimer — §3a tool-call filler audio", () => {
  it("does not fire onSlowToolCall for a tool that resolves well under the threshold", async () => {
    const calls: string[] = [];
    const wrapped = withFillerTimer(
      { execute: async () => "fast result" },
      "fastTool",
      (name) => calls.push(name),
    );
    const result = await wrapped.execute();
    // Give any (incorrectly still-pending) timer a moment to fire, to prove
    // it was actually cleared rather than just not-yet-fired.
    await new Promise((r) => setTimeout(r, 50));
    expect(result).toBe("fast result");
    expect(calls).toEqual([]);
  });

  it("fires onSlowToolCall exactly once when execute is still running past the threshold", async () => {
    const calls: string[] = [];
    const wrapped = withFillerTimer(
      {
        execute: async () => {
          await new Promise((r) => setTimeout(r, TOOL_CALL_FILLER_THRESHOLD_MS + 100));
          return "slow result";
        },
      },
      "slowTool",
      (name) => calls.push(name),
    );
    const result = await wrapped.execute();
    expect(result).toBe("slow result");
    expect(calls).toEqual(["slowTool"]);
  });

  it("is a no-op passthrough when no onSlowToolCall is given (text test-chat/synthetic-test callers)", async () => {
    const toolDef = { execute: async () => "result" };
    const wrapped = withFillerTimer(toolDef, "anyTool", undefined);
    expect(wrapped).toBe(toolDef);
  });

  it("passes real tool call arguments through unchanged", async () => {
    let received: unknown;
    const wrapped = withFillerTimer(
      {
        execute: async (input: unknown) => {
          received = input;
          return { ok: true };
        },
      },
      "echoTool",
      () => undefined,
    );
    await (wrapped.execute as (input: unknown) => Promise<unknown>)({ field: "email", value: "a@b.com" });
    expect(received).toEqual({ field: "email", value: "a@b.com" });
  });
});

describe("withToolTimeout — §4b bounding a single tool's network I/O (pilot latency audit F4)", () => {
  it("returns the real result unchanged when execute finishes inside the timeout", async () => {
    const wrapped = withToolTimeout({ execute: async () => ({ booked: true }) }, "bookAppointment", 50);
    const result = await wrapped.execute();
    expect(result).toEqual({ booked: true });
  });

  it("rethrows a real error unchanged when execute rejects inside the timeout", async () => {
    const wrapped = withToolTimeout(
      {
        execute: async () => {
          throw new Error("calendar API down");
        },
      },
      "bookAppointment",
      50,
    );
    await expect(wrapped.execute()).rejects.toThrow("calendar API down");
  });

  it("returns a timedOut placeholder result (not a thrown error) when execute outlasts the timeout", async () => {
    const wrapped = withToolTimeout(
      {
        execute: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return { booked: true };
        },
      },
      "bookAppointment",
      20,
    );
    const result = (await wrapped.execute()) as unknown as { timedOut: boolean; message: string };
    expect(result.timedOut).toBe(true);
    expect(result.message).toContain("bookAppointment");
  });

  it("does not abandon the real call — onLateResult reports its eventual success after timing out", async () => {
    let resolveReal!: (v: unknown) => void;
    const wrapped = withToolTimeout(
      {
        execute: () => new Promise((resolve) => { resolveReal = resolve; }),
      },
      "crmSync",
      10,
      (name, outcome) => {
        expect(name).toBe("crmSync");
        expect(outcome).toEqual({ status: "resolved", value: { synced: true } });
      },
    );
    const timedOutResult = await wrapped.execute();
    expect((timedOutResult as { timedOut: boolean }).timedOut).toBe(true);
    resolveReal({ synced: true });
    // Let the abandoned promise's .then(onLateResult) run.
    await new Promise((r) => setTimeout(r, 10));
  });

  it("reports a late rejection through onLateResult too, not just late successes", async () => {
    let rejectReal!: (e: unknown) => void;
    let lateOutcome: unknown;
    const wrapped = withToolTimeout(
      {
        execute: () => new Promise((_resolve, reject) => { rejectReal = reject; }),
      },
      "confirmCodOrder",
      10,
      (_name, outcome) => {
        lateOutcome = outcome;
      },
    );
    await wrapped.execute();
    rejectReal(new Error("shopify 500"));
    await new Promise((r) => setTimeout(r, 10));
    expect(lateOutcome).toMatchObject({ status: "rejected" });
  });

  it("is a no-op passthrough when the tool has no execute", () => {
    const toolDef: { execute?: (...args: never[]) => unknown; description: string } = {
      description: "no execute here",
    };
    const wrapped = withToolTimeout(toolDef, "anyTool", 50);
    expect(wrapped).toBe(toolDef);
  });
});

describe("buildVoiceTools — §3a wiring", () => {
  it("returns unwrapped tools when onSlowToolCall is omitted, unchanged from before §3a", () => {
    const tools = buildVoiceTools(undefined, undefined);
    expect(tools.captureField).toBeDefined();
    expect(tools.hangUp).toBeDefined();
  });

  it("still includes hangUp and respects enabledTools narrowing with onSlowToolCall wired", () => {
    const tools = buildVoiceTools(undefined, ["captureField"], () => undefined);
    expect(Object.keys(tools).sort()).toEqual(["captureField", "hangUp"]);
  });

  it("§4b: lookupInfo is timeout-gated — a slow execute yields a timedOut placeholder, not a hang", async () => {
    // lookupInfo has no orgId here, so its real execute resolves instantly
    // ({ query, results: [], note: ... } — see lookupInfo.ts's `if (!orgId)`
    // branch), which makes it a safe, deterministic tool to exercise the
    // wiring through without needing a live knowledge-base/DB mock. This
    // confirms the wrapping exists at the buildVoiceTools level, not just
    // that withToolTimeout works in isolation (covered above).
    const tools = buildVoiceTools(undefined);
    expect(tools.lookupInfo).toBeDefined();
    const result = await (tools.lookupInfo!.execute as (...args: unknown[]) => Promise<unknown>)(
      { query: "test" },
      { toolCallId: "t1", messages: [] },
    );
    expect(result).toMatchObject({ query: "test", results: [] });
  });

  it("§4b: captureField (in-process, no network I/O) is NOT timeout-gated", () => {
    // captureField isn't in TOOL_CALL_TIMEOUT_GATED — confirms the gating is
    // an allowlist, not applied to every tool indiscriminately.
    const tools = buildVoiceTools(undefined);
    // withToolTimeout wraps execute in a new closure; the untouched tool's
    // execute reference should be the same function voiceTools exports.
    expect(tools.captureField!.execute).toBe(voiceTools.captureField.execute);
  });
});

/**
 * G1.1 (2026-08-01) — registration is the enforcement mechanism.
 *
 * The merchant configures the discount in the workflow canvas; the model
 * only decides when to offer it. The way that's guaranteed is not a prompt
 * instruction and not a schema default — it's that a call with no
 * merchant-configured discount is never handed the tool in the first place.
 * A tool absent from the request cannot be called, however the model is
 * jailbroken or however the persona drifts. These tests pin exactly that.
 */
describe("buildVoiceTools — cart-recovery discount registration (G1.1)", () => {
  const CTX = { shop: "acme.myshopify.com", checkoutTokenOrOrderRef: "tok_1", percentOff: 15 };

  it("does not register offerCartRecoveryDiscount when no cart-recovery context is bound", () => {
    const tools = buildVoiceTools(undefined, undefined);
    expect("offerCartRecoveryDiscount" in tools).toBe(false);
  });

  it("registers it only once a merchant-authorized discount is bound to the call", () => {
    const tools = buildVoiceTools(undefined, undefined, undefined, CTX);
    expect("offerCartRecoveryDiscount" in tools).toBe(true);
  });

  it("does NOT register it just because the agent lists it in toolsEnabled — the per-call config is a second, binding gate", () => {
    const tools = buildVoiceTools(undefined, ["offerCartRecoveryDiscount", "captureField"]);
    expect("offerCartRecoveryDiscount" in tools).toBe(false);
    expect(Object.keys(tools).sort()).toEqual(["captureField", "hangUp"]);
  });

  it("still honours toolsEnabled narrowing when a discount IS bound — a merchant who turned the tool off doesn't get it back", () => {
    const tools = buildVoiceTools(undefined, ["captureField"], undefined, CTX);
    expect("offerCartRecoveryDiscount" in tools).toBe(false);
  });

  it("registers it when both gates pass", () => {
    const tools = buildVoiceTools(undefined, ["offerCartRecoveryDiscount"], undefined, CTX);
    expect(Object.keys(tools).sort()).toEqual(["hangUp", "offerCartRecoveryDiscount"]);
  });

  it("is not present in the static voiceTools map — it can only ever be built per-call", () => {
    expect("offerCartRecoveryDiscount" in voiceTools).toBe(false);
  });
});

/**
 * G1.4 / ADR-069 (2026-08-01). `crmSync` was the last tool that let the model
 * author the identity of the real-world record it writes: `phoneNumber` was a
 * required model input AND the CRM upsert key, so a hallucinated, mistranscribed
 * or caller-injected number appended this call's notes to somebody else's
 * contact — silently, because upsert never fails on a wrong key, it just matches
 * a different row. Same enforcement as the two tools above: the number is bound
 * server-side from the carrier's own call record, and a call with no resolvable
 * human number doesn't get the tool at all.
 */
describe("buildVoiceTools — CRM sync registration (G1.4 / ADR-069)", () => {
  const CRM = { orgId: "org-a", phoneNumber: "+15551234567" };

  it("does not register crmSync when no caller identity is bound", () => {
    const tools = buildVoiceTools(undefined, undefined);
    expect("crmSync" in tools).toBe(false);
  });

  it("registers it once the call's own org + carrier-reported number are bound", () => {
    const tools = buildVoiceTools("org-a", undefined, undefined, undefined, undefined, CRM);
    expect("crmSync" in tools).toBe(true);
  });

  it("does NOT register it just because the agent lists it in toolsEnabled", () => {
    // This is the case that matters in production: every seeded template lists
    // crmSync in defaultTools, so toolsEnabled alone must not be sufficient.
    const tools = buildVoiceTools("org-a", ["crmSync", "captureField"]);
    expect("crmSync" in tools).toBe(false);
    expect(Object.keys(tools).sort()).toEqual(["captureField", "hangUp"]);
  });

  it("still honours toolsEnabled narrowing when a caller IS bound", () => {
    const tools = buildVoiceTools("org-a", ["captureField"], undefined, undefined, undefined, CRM);
    expect("crmSync" in tools).toBe(false);
  });

  it("registers it when both gates pass", () => {
    const tools = buildVoiceTools("org-a", ["crmSync"], undefined, undefined, undefined, CRM);
    expect(Object.keys(tools).sort()).toEqual(["crmSync", "hangUp"]);
  });

  it("is not present in the static voiceTools map — it can only ever be built per-call", () => {
    // The text test-chat and the synthetic harness read the tool set through
    // buildVoiceTools with no CRM context, so this is also what keeps a test run
    // from writing contacts into a merchant's live CRM.
    expect("crmSync" in voiceTools).toBe(false);
  });
});

describe("buildWorkflowContextBlock — G1.3 pre-call facts from the merchant's workflow", () => {
  it("renders nothing when the call was not placed by a workflow", () => {
    // Every inbound call, and any outbound call dialled outside the workflow
    // engine — the block must be absent entirely, not an empty header.
    expect(buildWorkflowContextBlock(undefined)).toBe("");
    expect(buildWorkflowContextBlock({})).toBe("");
  });

  it("gives the agent the cart facts it is calling about", () => {
    // The G1.3 bug in one assertion: before this, scheduledCalls.metadata
    // reached the session and was consumed by nothing, so an outbound
    // cart-recovery agent dialled a customer knowing nothing about the cart.
    const block = buildWorkflowContextBlock({
      customer_name: "Asha",
      cart_value: 2499,
      currency: "₹",
      shop_name: "Kettle & Co",
      attempt_number: 2,
    });
    expect(block).toContain("Asha");
    expect(block).toContain("2499");
    expect(block).toContain("Kettle & Co");
    expect(block).toContain("attempt #2");
  });

  it("labels the facts as unconfirmed by the caller, separately from buildKnownFactsBlock", () => {
    // buildKnownFactsBlock = what THIS conversation confirmed (settled truth).
    // This block = what the workflow supplied going in. Conflating them is how
    // an agent starts asserting "you told me..." about something nobody said.
    const block = buildWorkflowContextBlock({ customer_name: "Asha" });
    expect(block).toContain("hasn't confirmed");
    expect(block).not.toContain("do not ask for these again");
  });

  it("carries the merchant-authorized discount and its code", () => {
    const block = buildWorkflowContextBlock({ discount_percent: 15, discount_code: "SAVE15" });
    expect(block).toContain("15%");
    expect(block).toContain("SAVE15");
  });

  it("says nothing about a discount when the merchant configured none", () => {
    // Must not emit a 0% line — the persona's instruction is to skip the
    // discount step entirely, and G1.1 does not even register the tool.
    const block = buildWorkflowContextBlock({ customer_name: "Asha", discount_percent: 0 });
    expect(block).not.toContain("discount");
    expect(block).not.toContain("0%");
  });

  it("emits no merge tags of its own — it is a values channel, not a template", () => {
    const block = buildWorkflowContextBlock({
      customer_name: "Asha",
      cart_value: 2499,
      currency: "₹",
      discount_code: "SAVE15",
      cart_recovery_url: "https://shop.example/checkout?discount=SAVE15",
    });
    expect(block).not.toContain("{{");
  });
});

import { composeSystemPrompt } from "./agent";
import { TOPIC_BOUNDARY_LINES, INJECTION_LINES, abuseHandlingLine } from "./prompt-lines";

/**
 * Phase III / D2 (ADR-067). The compiled-prompt panel in the agent editor is
 * only worth shipping if it shows the *actual* prompt — so the load-bearing
 * test here is the join invariant, not the labels. If a future layer gets
 * added to composition but not to `segments` (or vice versa), the panel starts
 * quietly lying to merchants about what their agent is told; this fails first.
 */
describe("composeSystemPrompt — one composition path, segmented", () => {
  const base = { jobDescription: "You help customers with their orders." };

  it("joins its segments back into exactly the compiled prompt, byte for byte", () => {
    const composed = composeSystemPrompt({
      ...base,
      identity: { name: "Aria", merchantName: "Kalyani Sarees", toneStyle: "friendly", greetingLine: "Hi!" },
      language: "hi",
      guardrails: { topicBoundaryStrictness: "high", injectionSensitivity: "low", abuseHandlingEnabled: false },
      toolsEnabled: ["hangUp", "captureField"],
      direction: "outbound",
    });
    expect(composed.segments.map((s) => s.body).join("")).toBe(composed.text);
  });

  it("holds the join invariant for the emptiest possible config too (no identity, no language, no guardrails)", () => {
    const composed = composeSystemPrompt(base);
    expect(composed.segments.map((s) => s.body).join("")).toBe(composed.text);
  });

  it("keeps layers that resolved to nothing in the array with an empty body, instead of dropping them", () => {
    // An English agent with no identity fields adds neither block — the panel
    // still needs to be able to say "not applied" rather than hide a layer.
    const composed = composeSystemPrompt({ ...base, language: "en" });
    const ids = composed.segments.map((s) => s.id);
    expect(ids).toEqual(["language", "identity", "persona", "disclosure", "call-control"]);
    expect(composed.segments.find((s) => s.id === "language")!.body).toBe("");
    expect(composed.segments.find((s) => s.id === "identity")!.body).toBe("");
  });

  it("marks exactly one segment editable — the merchant's own prompt — and that segment is their text verbatim", () => {
    const composed = composeSystemPrompt(base);
    const editable = composed.segments.filter((s) => s.editable);
    expect(editable).toHaveLength(1);
    expect(editable[0]!.id).toBe("persona");
    expect(editable[0]!.body).toBe(base.jobDescription);
  });

  it("isolates the disclosure into its own segment rather than blending it into the merchant's prompt", () => {
    const composed = composeSystemPrompt(base);
    const persona = composed.segments.find((s) => s.id === "persona")!;
    const disclosure = composed.segments.find((s) => s.id === "disclosure")!;
    expect(persona.body).not.toContain("At the very start of the call");
    expect(disclosure.body).toContain("At the very start of the call");
  });

  it("produces the same string the previous hand-rolled composition did (regression guard on the refactor)", () => {
    const composed = composeSystemPrompt({
      ...base,
      identity: { name: "Aria" },
      guardrails: { topicBoundaryStrictness: "medium" },
    });
    expect(composed.text.startsWith("Your name is Aria.")).toBe(true);
    expect(composed.text).toContain("You help customers with their orders.");
    expect(composed.text).toContain("Call control:");
    expect(composed.text).toContain(TOPIC_BOUNDARY_LINES.medium);
  });

  it("puts the guardrail dial's resulting sentence in the prompt, so the editor can show that same sentence", () => {
    for (const level of ["low", "medium", "high"] as const) {
      const composed = composeSystemPrompt({
        ...base,
        guardrails: { topicBoundaryStrictness: level, injectionSensitivity: level },
      });
      expect(composed.text).toContain(TOPIC_BOUNDARY_LINES[level]);
      expect(composed.text).toContain(INJECTION_LINES[level]);
    }
  });

  it("swaps the abuse sentence for the flagGuardrailEvent-free variant when that tool is off", () => {
    const withFlag = composeSystemPrompt({ ...base, toolsEnabled: ["flagGuardrailEvent", "hangUp"] });
    const withoutFlag = composeSystemPrompt({ ...base, toolsEnabled: ["hangUp"] });
    expect(withFlag.text).toContain(abuseHandlingLine(true, true));
    expect(withoutFlag.text).toContain(abuseHandlingLine(true, false));
    expect(withoutFlag.text).not.toContain("flagGuardrailEvent");
  });

  it("indents the call-control block consistently — no line carries stray template indentation", () => {
    // Regression guard (2026-08-01). This block used to be built with a
    // dedent`` template whose interpolated constants were flush-left, so
    // dedent's minimum-indent calculation always came out 0 and stripped
    // nothing: literal lines shipped with 6 leading spaces while interpolated
    // continuation lines had none. Nobody noticed until the D2 compiled-prompt
    // panel rendered it for a human. Bullets use a 2-space hanging indent, so
    // anything deeper than that is the bug coming back.
    for (const direction of ["inbound", "outbound"] as const) {
      const composed = composeSystemPrompt({
        ...base,
        direction,
        identity: { name: "Aria", merchantName: "Preview Store" },
      });
      const callControl = composed.segments.find((s) => s.id === "call-control")!;
      const overIndented = callControl.body.split("\n").filter((l) => /^ {3,}/.test(l));
      expect(overIndented).toEqual([]);
    }
  });

  it("changes only the call-control segment when a tool is toggled — the editor's diff highlight depends on this", () => {
    const before = composeSystemPrompt({ ...base, toolsEnabled: ["hangUp", "transferToHuman"] });
    const after = composeSystemPrompt({ ...base, toolsEnabled: ["hangUp"] });
    const changed = before.segments
      .filter((s, i) => s.body !== after.segments[i]!.body)
      .map((s) => s.id);
    expect(changed).toEqual(["call-control"]);
  });
});

/**
 * ADR-115. `resolveAgentConfig` now hands back the inputs its prompt was
 * composed from so stream.ts can rebuild the call-control layer once it learns
 * the call cannot hand off. Two things have to stay true for that to be safe:
 * recomposing the inputs must reproduce the prompt byte-for-byte, and the
 * fallback paths that used to call `resolvePersona` must not have drifted from
 * it.
 */
import { test } from "bun:test";
import { resolvePersonaBody } from "./agent";

describe("promptInputs (ADR-115)", () => {
  const body = "You are Sara. Qualify the caller, then hand them to a licensed advisor.";

  test("composing the inputs reproduces resolvePersona's output byte-for-byte", async () => {
    for (const direction of ["inbound", "outbound"] as const) {
      const viaPersona = await resolvePersona({ explicitPersona: body, direction });
      const viaCompose = composeSystemPrompt({ jobDescription: body, direction }).text;
      expect(viaCompose).toBe(viaPersona);
    }
  });

  test("resolvePersonaBody returns the body without the layers", async () => {
    const bodyOnly = await resolvePersonaBody({ explicitPersona: body });
    expect(bodyOnly).toBe(body);
    expect(bodyOnly).not.toContain("Call control:");
  });

  test("recomposing with the narrowed list drops the transfer-capable text", () => {
    const withTransfer = composeSystemPrompt({
      jobDescription: body,
      toolsEnabled: ["hangUp", "transferToHuman"],
    }).text;
    const narrowed = composeSystemPrompt({ jobDescription: body, toolsEnabled: ["hangUp"] }).text;
    expect(withTransfer).toContain("Say you are connecting them");
    expect(narrowed).not.toContain("Say you are connecting them");
    expect(narrowed).toContain("there's no live transfer available on this call");
  });
});
