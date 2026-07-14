import { describe, it, expect, beforeEach } from "bun:test";
import { buildKnownFactsBlock } from "./agent";

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
});

import { withFillerTimer, TOOL_CALL_FILLER_THRESHOLD_MS, buildVoiceTools } from "./agent";

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
