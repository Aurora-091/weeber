import { describe, it, expect, beforeEach } from "bun:test";
import { buildKnownFactsBlock, buildWorkflowContextBlock, resolveAgentConfig } from "./agent";
import { INSURANCE_GREETINGS } from "./insurance-greetings";

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
    expect(persona).toContain("You are OpenVent");
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

import { withFillerTimer, TOOL_CALL_FILLER_THRESHOLD_MS, buildVoiceTools, voiceTools } from "./agent";

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
