import { describe, it, expect } from "bun:test";
import { getVertical } from "./verticals";

describe("verticals helper", () => {
  it("resolves the default vertical (shopify) for undefined or null inputs", () => {
    const fallbackNull = getVertical(null);
    expect(fallbackNull).toBeDefined();
    expect(fallbackNull.key).toBe("shopify");
    expect(fallbackNull.integrationLabel).toBe("Shopify");

    const fallbackUndefined = getVertical(undefined);
    expect(fallbackUndefined).toBeDefined();
    expect(fallbackUndefined.key).toBe("shopify");
  });

  it("resolves shopify vertical correctly", () => {
    const v = getVertical("shopify");
    expect(v.key).toBe("shopify");
    expect(v.glossary.customer).toBe("Customer");
    expect(v.glossary.customers).toBe("Customers");
    // Home, Agents, Workflows, Conversations, Analytics, Billing, Shopify
    // (integrationLabel), Settings.
    expect(v.nav).toHaveLength(8);
  });

  it("falls back to shopify vertical for unrecognized keys", () => {
    const v = getVertical("invalid-key-vertical");
    expect(v.key).toBe("shopify");
  });

  it("contains all required nav items for shopify", () => {
    const v = getVertical("shopify");
    const labels = v.nav.map((n) => n.label);
    // "Home" replaces the old "Setup" nav entry — onboarding is a modal
    // opened from the dashboard now, not its own page/nav item (see
    // DECISIONS.md ADR-047, "Setup modal, not a setup page").
    expect(labels).toContain("Home");
    expect(labels).toContain("Agents");
    expect(labels).toContain("Conversations");
    expect(labels).toContain("Analytics");
    expect(labels).toContain("Billing");
    // The platform-connection nav item is labeled per-vertical via
    // integrationLabel, not a hardcoded "Integrations" — "Shopify" here.
    expect(labels).toContain("Shopify");
  });

  it("resolves insurance vertical with Policyholder glossary and no Integrations nav item", () => {
    const v = getVertical("insurance");
    expect(v.key).toBe("insurance");
    expect(v.glossary.customer).toBe("Policyholder");
    expect(v.glossary.customers).toBe("Policyholders");
    // Home, Agents, Workflows, Conversations, Analytics, Billing, Settings —
    // deliberately no 8th "Integrations"-equivalent item, since no live
    // policy-system integration exists yet (see verticals.ts's own comment
    // right above the insurance definition).
    expect(v.nav).toHaveLength(7);
    const labels = v.nav.map((n) => n.label);
    expect(labels).not.toContain("Policy System");
  });
});
