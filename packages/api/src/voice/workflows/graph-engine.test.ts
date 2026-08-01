import { describe, test, expect } from "bun:test";
import { resolveDiscountPercent, clampDiscount, renderTemplate, composeCartRecoveryUrl, buildWorkflowFactsBlock } from "./variables";
import type { CallConfig, WorkflowGraph } from "./graph-types";

describe("clampDiscount", () => {
  test("zero stays zero (no discount offered)", () => {
    expect(clampDiscount(0)).toBe(0);
  });

  test("negative stays zero", () => {
    expect(clampDiscount(-5)).toBe(0);
  });

  test("value within range passes through", () => {
    expect(clampDiscount(10)).toBe(10);
    expect(clampDiscount(1)).toBe(1);
    expect(clampDiscount(30)).toBe(30);
  });

  test("value above 30 gets clamped to 30", () => {
    expect(clampDiscount(90)).toBe(30);
    expect(clampDiscount(50)).toBe(30);
  });
});

describe("resolveDiscountPercent", () => {
  test("flat number config", () => {
    const config: CallConfig = { persona: "test", discountPercent: 15 };
    expect(resolveDiscountPercent(config, 1)).toBe(15);
    expect(resolveDiscountPercent(config, 3)).toBe(15);
  });

  test("flat number clamped at ceiling", () => {
    const config: CallConfig = { persona: "test", discountPercent: 50 };
    expect(resolveDiscountPercent(config, 1)).toBe(30);
  });

  test("escalating map — per-attempt values", () => {
    const config: CallConfig = {
      persona: "test",
      discountPercent: { "1": 0, "2": 10, "3": 20 },
    };
    expect(resolveDiscountPercent(config, 1)).toBe(0);
    expect(resolveDiscountPercent(config, 2)).toBe(10);
    expect(resolveDiscountPercent(config, 3)).toBe(20);
  });

  test("escalating map — missing attempt falls to 0", () => {
    const config: CallConfig = {
      persona: "test",
      discountPercent: { "2": 10 },
    };
    expect(resolveDiscountPercent(config, 1)).toBe(0);
    expect(resolveDiscountPercent(config, 5)).toBe(0);
  });

  test("escalating map — values above 30 clamped", () => {
    const config: CallConfig = {
      persona: "test",
      discountPercent: { "1": 90 },
    };
    expect(resolveDiscountPercent(config, 1)).toBe(30);
  });
});

describe("renderTemplate", () => {
  test("replaces known merge tags", () => {
    const result = renderTemplate(
      "Hi {{customer_name}}, your cart ({{currency}}{{cart_value}}) is waiting!",
      { customer_name: "Raj", currency: "INR", cart_value: "2500" },
    );
    expect(result).toBe("Hi Raj, your cart (INR2500) is waiting!");
  });

  test("leaves unknown tags intact", () => {
    const result = renderTemplate("Hello {{unknown_tag}}", { customer_name: "Test" });
    expect(result).toBe("Hello {{unknown_tag}}");
  });

  test("handles numeric values", () => {
    const result = renderTemplate("Attempt {{attempt_number}}", { attempt_number: 3 });
    expect(result).toBe("Attempt 3");
  });
});

describe("composeCartRecoveryUrl", () => {
  test("appends discount code with ? separator", () => {
    const url = composeCartRecoveryUrl("https://shop.myshopify.com/checkouts/abc123", "SAVE10");
    expect(url).toBe("https://shop.myshopify.com/checkouts/abc123?discount=SAVE10");
  });

  test("appends discount code with & separator when URL has existing query", () => {
    const url = composeCartRecoveryUrl("https://shop.myshopify.com/checkouts/abc123?ref=email", "SAVE10");
    expect(url).toBe("https://shop.myshopify.com/checkouts/abc123?ref=email&discount=SAVE10");
  });

  test("encodes special characters in discount code", () => {
    const url = composeCartRecoveryUrl("https://shop.myshopify.com/checkouts/x", "SAVE 10%");
    expect(url).toBe("https://shop.myshopify.com/checkouts/x?discount=SAVE%2010%25");
  });

  test("returns empty string when no URL", () => {
    expect(composeCartRecoveryUrl("", "CODE")).toBe("");
  });

  test("returns raw URL when no discount code", () => {
    expect(composeCartRecoveryUrl("https://example.com/cart", "")).toBe("https://example.com/cart");
  });
});

describe("buildWorkflowFactsBlock", () => {
  test("builds full context string", () => {
    const result = buildWorkflowFactsBlock({
      customer_name: "Priya",
      cart_value: "3500",
      currency: "INR",
      shop_name: "TestShop",
      attempt_number: 2,
      discount_percent: 10,
      discount_code: "SAVE10",
      cart_recovery_url: "https://shop.com/cart?discount=SAVE10",
    });
    expect(result).toContain("Customer: Priya.");
    expect(result).toContain("Cart value: INR3500.");
    expect(result).toContain("Shop: TestShop.");
    expect(result).toContain("call attempt #2");
    expect(result).toContain("offer exactly 10%");
    expect(result).toContain("Discount code to share: SAVE10.");
    expect(result).toContain("Cart recovery link (with discount): https://shop.com/cart?discount=SAVE10.");
  });

  test("returns empty string for empty context", () => {
    expect(buildWorkflowFactsBlock({})).toBe("");
  });

  test("skips discount line when percent is 0", () => {
    const result = buildWorkflowFactsBlock({ discount_percent: 0, attempt_number: 1 });
    expect(result).not.toContain("offering a discount");
    expect(result).toContain("call attempt #1");
  });

  // G1.3: the COD producer (integrations/shopify/routes.ts) writes camelCase
  // `orderId` and no `currency`. Before this, the block emitted neither, so a
  // COD confirmation agent never learned the order or the amount it exists to
  // confirm — it could only ask the customer to supply both.
  test("emits the order reference from camelCase orderId — what the COD producer actually writes", () => {
    const result = buildWorkflowFactsBlock({ orderId: 1234, shop_name: "TestShop" });
    expect(result).toContain("Order reference: #1234.");
  });

  test("emits the order reference from snake_case order_id too", () => {
    expect(buildWorkflowFactsBlock({ order_id: "1234" })).toContain("Order reference: #1234.");
  });

  test("prefers order_id when both spellings are present", () => {
    const result = buildWorkflowFactsBlock({ order_id: 111, orderId: 222 });
    expect(result).toContain("Order reference: #111.");
    expect(result).not.toContain("#222");
  });

  test("emits the amount even when the producer forgot the currency, and tells the agent not to invent one", () => {
    const result = buildWorkflowFactsBlock({ orderId: 1234, cart_value: "899.00" });
    expect(result).toContain("899.00");
    expect(result).toContain("currency unknown");
    expect(result).not.toContain("INR");
  });

  test("labels the amount as an order value once an order exists, and a cart value before one does", () => {
    expect(buildWorkflowFactsBlock({ orderId: 7, cart_value: "500", currency: "INR" }))
      .toContain("Order value: INR500.");
    expect(buildWorkflowFactsBlock({ cart_value: "500", currency: "INR" }))
      .toContain("Cart value: INR500.");
  });

  test("emits no order line when there is no order reference — a cart-recovery call has no order yet", () => {
    expect(buildWorkflowFactsBlock({ customer_name: "Priya", cart_value: "500", currency: "INR" }))
      .not.toContain("Order reference");
  });
});

describe("graph validation (via seed graph structure)", () => {
  // Import the seed graph to test structural correctness
  const { CART_RECOVERY_GRAPH } = require("./seed-graph") as { CART_RECOVERY_GRAPH: WorkflowGraph };

  test("seed graph has a trigger node", () => {
    const triggers = CART_RECOVERY_GRAPH.nodes.filter((n) => n.type === "trigger");
    expect(triggers.length).toBeGreaterThan(0);
  });

  test("all edges reference existing nodes", () => {
    const nodeIds = new Set(CART_RECOVERY_GRAPH.nodes.map((n) => n.id));
    for (const edge of CART_RECOVERY_GRAPH.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });

  test("every conditionalSplit node has a default outgoing edge", () => {
    const splits = CART_RECOVERY_GRAPH.nodes.filter((n) => n.type === "conditionalSplit");
    for (const split of splits) {
      const outgoing = CART_RECOVERY_GRAPH.edges.filter((e) => e.source === split.id);
      const hasDefault = outgoing.some((e) => e.branch === "default");
      expect(hasDefault).toBe(true);
    }
  });

  test("conditionalSplit nodes have edges for each declared outcome", () => {
    const splits = CART_RECOVERY_GRAPH.nodes.filter((n) => n.type === "conditionalSplit");
    for (const split of splits) {
      const config = split.config as { outcomes: string[] };
      const outgoing = CART_RECOVERY_GRAPH.edges.filter((e) => e.source === split.id);
      const branches = new Set(outgoing.map((e) => e.branch).filter(Boolean));
      for (const outcome of config.outcomes) {
        // Either has a direct edge OR falls through to default
        const hasDirect = branches.has(outcome);
        const hasDefault = branches.has("default");
        expect(hasDirect || hasDefault).toBe(true);
      }
    }
  });
});
