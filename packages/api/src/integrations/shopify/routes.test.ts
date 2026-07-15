import { mock, describe, it, expect, beforeEach } from "bun:test";

let mockInsertedCalls: any[] = [];
let mockSelectedShopLinks: any[] = [];
let mockSelectedCalls: any[] = [];
let mockUpdatedCalls: any[] = [];
let mockReturningRows: any[] = [];
let mockDeletedRows: any[] = [];
let mockMarkedProcessed: { shop: string; topic: string; idempotencyKey: string }[] = [];

function getTableName(table: any): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find(s => s.toString() === "Symbol(drizzle:Name)");
  return sym ? table[sym] : undefined;
}

mock.module("../../database", () => {
  return {
    db: {
      insert: (_table: any) => ({
        values: (data: any) => {
          mockInsertedCalls.push(data);
          return Promise.resolve();
        }
      }),
      select: () => ({
        from: (table: any) => {
          const tableName = getTableName(table);
          const rows = tableName === "shop_links" ? mockSelectedShopLinks : mockSelectedCalls;
          return {
            where: () => {
              // Real Drizzle: `.where(...)` alone (no `.limit()`) is itself
              // awaitable and resolves to every matching row — used by
              // findActiveWorkflowTemplate's `for (const tpl of templates)`.
              // Attach `.limit()`/`.orderBy()` onto the same array instance
              // so both calling styles (`await db...where()` and
              // `await db...where().limit()`) work against one mock shape.
              return Object.assign([...rows], {
                limit: () => rows,
                orderBy: () => ({
                  limit: () => mockSelectedCalls
                })
              });
            }
          };
        }
      }),
      update: (_table: any) => ({
        set: (data: any) => ({
          where: () => {
            mockUpdatedCalls.push({ ...data });
            return {
              returning: () => mockReturningRows
            };
          }
        })
      }),
      delete: (table: any) => {
        const tableName = getTableName(table);
        return {
          where: () => {
            mockDeletedRows.push({ tableName });
            return {
              returning: () => [{ id: 999 }]
            };
          }
        };
      }
    }
  };
});

mock.module("./idempotency", () => {
  return {
    alreadyProcessed: () => Promise.resolve(false),
    markProcessed: (shop: string, topic: string, idempotencyKey: string) => {
      mockMarkedProcessed.push({ shop, topic, idempotencyKey });
      return Promise.resolve();
    }
  };
});

process.env.WEEBER_INTERNAL_SECRET = "test-secret";

import { shopify } from "./routes";

describe("Shopify routes - Checkout Token cancellation and Attribution", () => {
  beforeEach(() => {
    mockInsertedCalls = [];
    mockSelectedShopLinks = [];
    mockSelectedCalls = [];
    mockUpdatedCalls = [];
    mockReturningRows = [];
    mockDeletedRows = [];
    mockMarkedProcessed = [];
  });

  it("persists checkoutToken on checkout webhook", async () => {
    mockSelectedShopLinks = [{ orgId: "org-123", shop: "test.myshopify.com" }];
    const res = await shopify.request("/integrations/shopify/webhooks/checkouts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Weeber-Secret": "test-secret"
      },
      body: JSON.stringify({
        shop: "test.myshopify.com",
        topic: "checkouts/create",
        body: {
          token: "chk_token_abc123",
          phone: "+15555555555",
          total_price: "100.00"
        }
      })
    });
    expect(res.status).toBe(200);
    expect(mockInsertedCalls.length).toBe(1);
    expect(mockInsertedCalls[0].checkoutToken).toBe("chk_token_abc123");
    expect(mockInsertedCalls[0].toNumber).toBe("+15555555555");
  });

  it("cancels pending cart-recovery calls by checkoutToken first", async () => {
    mockSelectedShopLinks = [{ orgId: "org-123", shop: "test.myshopify.com" }];
    mockReturningRows = [{ id: 456 }]; // simulate successfully finding and updating a row by token

    const res = await shopify.request("/integrations/shopify/orders/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Weeber-Secret": "test-secret"
      },
      body: JSON.stringify({
        shop: "test.myshopify.com",
        order_id: 12345,
        checkout_token: "chk_token_abc123",
        phone: "+15555555555"
      })
    });

    expect(res.status).toBe(200);
    // Should have updated status to canceled
    expect(mockUpdatedCalls.length).toBe(1);
    expect(mockUpdatedCalls[0].status).toBe("canceled");
  });

  // Regression coverage for the 2026-07-16 merchant-reported bug: a real
  // order they placed got counted as an abandoned cart on the dashboard.
  // Root cause: Shopify fires a "checkouts" webhook for every checkout,
  // including ones that complete into a real order — org-queries.ts's
  // cartsAbandoned had no way to exclude those. Fix: /orders/create marks
  // the checkout "converted" (separate topic, same idempotency log, keyed
  // by checkout_token) so the KPI query can exclude it.
  it("marks the checkout as converted (topic checkout_converted, keyed by checkout_token) when an order carries one", async () => {
    mockSelectedShopLinks = [{ orgId: "org-123", shop: "test.myshopify.com" }];
    mockReturningRows = [];

    const res = await shopify.request("/integrations/shopify/orders/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Weeber-Secret": "test-secret"
      },
      body: JSON.stringify({
        shop: "test.myshopify.com",
        order_id: 12345,
        checkout_token: "chk_token_abc123",
        phone: "+15555555555"
      })
    });

    expect(res.status).toBe(200);
    expect(mockMarkedProcessed).toContainEqual({ shop: "test.myshopify.com", topic: "checkout_converted", idempotencyKey: "chk_token_abc123" });
  });

  it("does not attempt to mark a conversion when the order has no checkout_token at all (e.g. a POS sale)", async () => {
    mockSelectedShopLinks = [{ orgId: "org-123", shop: "test.myshopify.com" }];
    mockReturningRows = [];

    const res = await shopify.request("/integrations/shopify/orders/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Weeber-Secret": "test-secret"
      },
      body: JSON.stringify({
        shop: "test.myshopify.com",
        order_id: 99999
      })
    });

    expect(res.status).toBe(200);
    expect(mockMarkedProcessed.some((m) => m.topic === "checkout_converted")).toBe(false);
  });

  it("falls back to canceling by phone if no call was found by checkoutToken", async () => {
    mockSelectedShopLinks = [{ orgId: "org-123", shop: "test.myshopify.com" }];
    mockReturningRows = []; // token cancellation did not find any row

    const res = await shopify.request("/integrations/shopify/orders/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Weeber-Secret": "test-secret"
      },
      body: JSON.stringify({
        shop: "test.myshopify.com",
        order_id: 12345,
        checkout_token: "chk_token_abc123",
        phone: "+15555555555"
      })
    });

    expect(res.status).toBe(200);
    // Should have run two updates: first by token (which returned empty), then by phone
    expect(mockUpdatedCalls.length).toBe(2);
    expect(mockUpdatedCalls[0].status).toBe("canceled");
    expect(mockUpdatedCalls[1].status).toBe("canceled");
  });

  it("attributes order value to executed cart recovery call in last 7 days", async () => {
    mockSelectedShopLinks = [{ orgId: "org-123", shop: "test.myshopify.com" }];
    // Mock select result to return a match for the recovery call
    mockSelectedCalls = [{ id: 789, toNumber: "+15555555555" }];
    mockReturningRows = []; // we aren't testing order cancellation in this test, just the attribution update

    const res = await shopify.request("/integrations/shopify/orders/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Weeber-Secret": "test-secret"
      },
      body: JSON.stringify({
        shop: "test.myshopify.com",
        order_id: 12345,
        checkout_token: "chk_token_abc123",
        phone: "+15555555555",
        total_price: "99.99"
      })
    });

    expect(res.status).toBe(200);
    // The attribution update should write recoveredOrderId and recoveredAmount
    const attributionUpdate = mockUpdatedCalls.find(u => u.recoveredOrderId !== undefined);
    expect(attributionUpdate).toBeDefined();
    expect(attributionUpdate.recoveredOrderId).toBe("12345");
    expect(attributionUpdate.recoveredAmount).toBe("99.99");
  });

  it("deletes contact, calls, transcripts, caller memory and fires GDPR redact notification", async () => {
    mockSelectedShopLinks = [{ orgId: "org-123", shop: "test.myshopify.com" }];
    
    // Stub fetch
    const originalFetch = global.fetch;
    let fetchedUrl = "";
    let fetchedOptions: any = null;
    global.fetch = (async (url: string, options: any) => {
      fetchedUrl = url;
      fetchedOptions = options;
      return new Response(JSON.stringify({ acknowledged: true }), { status: 200 });
    }) as unknown as typeof fetch;

    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

    try {
      const res = await shopify.request("/integrations/shopify/customers/redact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Weeber-Secret": "test-secret"
        },
        body: JSON.stringify({
          shop: "test.myshopify.com",
          customer: {
            phone: "+15555555555"
          }
        })
      });

      expect(res.status).toBe(200);

      // Verify deletions occurred
      // shopifyContacts, scheduledCalls, callerMemory, calls should be in mockDeletedRows
      const deletedTables = mockDeletedRows.map(r => r.tableName);
      expect(deletedTables).toContain("shopify_contacts");
      expect(deletedTables).toContain("scheduled_calls");
      expect(deletedTables).toContain("caller_memory");
      expect(deletedTables).toContain("calls");

      // Wait 10ms to let fire-and-forget resilientCall run (since it is asynchronous/voided)
      await new Promise(resolve => setTimeout(resolve, 20));

      // Verify fetch was triggered correctly
      expect(fetchedUrl).toBe("https://example.supabase.co/functions/v1/gdpr-redact-notify");
      expect(fetchedOptions).toBeDefined();
      expect(fetchedOptions.method).toBe("POST");
      expect(JSON.parse(fetchedOptions.body)).toEqual({
        shop: "test.myshopify.com",
        e164Redacted: "+15555555555"
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
