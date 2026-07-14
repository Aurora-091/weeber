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
    // Home, Agents, Workflows, Conversations, Billing, Shopify (integrationLabel), Settings.
    // Analytics was folded into Home (dashboard consolidation pass); Knowledge Base added (A3b).
    expect(v.nav).toHaveLength(8);
  });

  it("falls back to shopify vertical for unrecognized keys", () => {
    const v = getVertical("invalid-key-vertical");
    expect(v.key).toBe("shopify");
  });

  it("contains all required nav items for shopify", () => {
    const v = getVertical("shopify");
    const labels = v.nav.map((n) => n.label);
    expect(labels).toContain("Home");
    expect(labels).toContain("Agents");
    expect(labels).toContain("Conversations");
    expect(labels).toContain("Billing");
    expect(labels).toContain("Shopify");
    // Analytics is no longer a separate nav item — it lives on the Home page.
    expect(labels).not.toContain("Analytics");
  });

  it("resolves insurance vertical with Policyholder glossary and no Integrations nav item", () => {
    const v = getVertical("insurance");
    expect(v.key).toBe("insurance");
    expect(v.glossary.customer).toBe("Policyholder");
    expect(v.glossary.customers).toBe("Policyholders");
    // Home, Agents, Workflows, Conversations, Billing, Knowledge Base, Settings —
    // no Integrations item (no live policy-system integration yet),
    // no Analytics item (folded into Home).
    expect(v.nav).toHaveLength(7);
    const labels = v.nav.map((n) => n.label);
    expect(labels).not.toContain("Policy System");
    expect(labels).not.toContain("Analytics");
  });
});
