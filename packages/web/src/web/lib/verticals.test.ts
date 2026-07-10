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
    expect(v.nav).toHaveLength(6);
  });

  it("falls back to shopify vertical for unrecognized keys", () => {
    const v = getVertical("invalid-key-vertical");
    expect(v.key).toBe("shopify");
  });

  it("contains all required nav items for shopify", () => {
    const v = getVertical("shopify");
    const labels = v.nav.map((n) => n.label);
    expect(labels).toContain("Setup");
    expect(labels).toContain("Agents");
    expect(labels).toContain("Conversations");
    expect(labels).toContain("Analytics");
    expect(labels).toContain("Billing");
    expect(labels).toContain("Shopify");
  });
});
