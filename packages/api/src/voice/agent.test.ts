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
