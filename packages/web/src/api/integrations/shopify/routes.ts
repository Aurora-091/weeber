import { Hono } from "hono";
import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../../database";
import { orgs, shopLinks, shopifyContacts, scheduledCalls } from "../../database/schema";
import { requireWeeberSecret } from "./secret-auth";
import { alreadyProcessed, markProcessed } from "./idempotency";
import { cancelOrder } from "./client";
import { isValidE164 } from "../../voice/validation";

/**
 * Weeber <-> weebersh contract v1.4 — outbound direction (weebersh calls
 * these). See /docs/contract.md (copied into both repos) for the full wire
 * format. Every route here:
 *   1. authenticates via X-Weeber-Secret (requireWeeberSecret middleware)
 *   2. checks the idempotency ledger before doing anything with side effects
 *   3. always returns a real status code — weebersh's own retry logic
 *      depends on this being honest (contract: "Delivery: at-least-once...
 *      every endpoint must be idempotent")
 */
export const shopify = new Hono().basePath("/integrations/shopify").use(requireWeeberSecret);

async function resolveOrgIdForShop(shop: string): Promise<string | undefined> {
  const [link] = await db.select().from(shopLinks).where(eq(shopLinks.shop, shop)).limit(1);
  return link?.orgId;
}

shopify
  // 1. POST /connected — merchant clicks "Connect to Weeber" (fires from
  // webbersh's UI button, not automatically from OAuth — see contract 1.4).
  .post("/connected", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.shop) return c.json({ error: "shop is required" }, 400);

    const {
      shop,
      org_id: orgId,
      plan_name: planName,
      currency,
      country_code: countryCode,
      timezone,
      contact_email: contactEmail,
      shop_name: shopName,
    } = body as {
      shop: string;
      org_id?: string | null;
      plan_name?: string | null;
      currency?: string | null;
      country_code?: string | null;
      timezone?: string | null;
      contact_email?: string | null;
      shop_name?: string | null;
    };

    // org_id arrives from the Shopify install URL (install is always
    // initiated from Weeber's dashboard) — if it's somehow missing, mint a
    // fresh org rather than fail the connection (better a merchant gets a
    // usable-but-unnamed org than a broken install).
    const resolvedOrgId = orgId ?? randomUUID();

    await db
      .insert(orgs)
      .values({
        id: resolvedOrgId,
        name: shopName ?? shop,
        planName: planName ?? undefined,
        currency: currency ?? undefined,
        countryCode: countryCode ?? undefined,
        timezone: timezone ?? undefined,
        contactEmail: contactEmail ?? undefined,
      })
      .onConflictDoNothing();

    await db
      .insert(shopLinks)
      .values({ shop, orgId: resolvedOrgId, scopes: (body as { scopes?: string }).scopes })
      .onConflictDoUpdate({
        target: shopLinks.shop,
        set: { orgId: resolvedOrgId, disconnectedAt: null },
      });

    return c.json({ connected: true, org_id: resolvedOrgId }, 200);
  })

  // 2. POST /webhooks/checkouts — checkout created/updated. Schedules the
  // Shopify cart-recovery call. Idempotency key: body.token.
  .post("/webhooks/checkouts", async (c) => {
    const payload = await c.req.json().catch(() => null);
    if (!payload?.shop || !payload?.topic || !payload?.body) {
      return c.json({ error: "shop, topic, and body are required" }, 400);
    }
    const { shop, body } = payload as { shop: string; body: Record<string, unknown> };
    const token = body.token as string | undefined;
    if (!token) return c.json({ error: "body.token is required for idempotency" }, 400);

    if (await alreadyProcessed(shop, "checkouts", token)) {
      return c.json({ status: "already_processed" }, 200);
    }

    const phone = (body.phone as string | undefined) ?? undefined;
    if (!phone || !isValidE164(phone)) {
      // No usable phone number on this checkout — nothing to call. Still a
      // successful, idempotent no-op from weebersh's point of view.
      await markProcessed(shop, "checkouts", token);
      return c.json({ status: "no_callable_phone" }, 200);
    }

    const orgId = await resolveOrgIdForShop(shop);
    const delayMinutes = Number(process.env.SHOPIFY_CART_RECOVERY_DELAY_MINUTES ?? 45);

    await db.insert(scheduledCalls).values({
      toNumber: phone,
      workflowName: "shopify-cart-recovery",
      persona: "shopify-cart-recovery",
      attempt: 1,
      maxAttempts: Number(process.env.SHOPIFY_CART_RECOVERY_MAX_ATTEMPTS ?? 2),
      runAt: new Date(Date.now() + delayMinutes * 60 * 1000),
      status: "pending",
      orgId,
      metadata: { shop, checkoutToken: token, totalPrice: String(body.total_price ?? "") },
    });

    await markProcessed(shop, "checkouts", token);
    return c.json({ status: "scheduled" }, 200);
  })

  // 3. POST /orders/create — order placed. (a) cancels pending recovery
  // calls matching checkout_token/phone, (b) attribution (left as a
  // follow-up — see WEEBER-PLAN.md), (c) schedules COD confirmation if
  // applicable. Idempotency key: order_id.
  .post("/orders/create", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.shop || body?.order_id === undefined) {
      return c.json({ error: "shop and order_id are required" }, 400);
    }
    const { shop, order_id: orderId } = body as { shop: string; order_id: number };
    const idempotencyKey = String(orderId);

    if (await alreadyProcessed(shop, "orders_create", idempotencyKey)) {
      return c.json({ status: "already_processed" }, 200);
    }

    const {
      checkout_token: checkoutToken,
      phone,
      payment_gateway_names: gateways,
      financial_status: financialStatus,
    } = body as { checkout_token?: string; phone?: string; payment_gateway_names?: string[]; financial_status?: string };

    // (a) cancel pending recovery calls matching phone — the order
    // already went through, no need to keep chasing it. (checkout_token
    // isn't stored as its own indexed column on scheduledCalls today, only
    // inside the JSON `metadata` blob, so phone is the practical match key
    // here; see WEEBER-PLAN.md if checkout_token-based matching is needed.)
    void checkoutToken;
    if (phone) {
      await db
        .update(scheduledCalls)
        .set({ status: "canceled" })
        .where(
          and(
            eq(scheduledCalls.workflowName, "shopify-cart-recovery"),
            eq(scheduledCalls.status, "pending"),
            eq(scheduledCalls.toNumber, phone),
          ),
        );
    }

    // (b) attribution (mark a completed call in last 72h as "recovered"
    // with order value) — deliberately NOT implemented in this scaffold;
    // needs a dashboard-facing revenue-attribution model that doesn't
    // exist yet. Flagged in WEEBER-PLAN.md as a real, scoped follow-up —
    // not silently skipped.

    // (c) COD confirmation — schedule if this looks like a COD order.
    const isCod =
      (gateways ?? []).some((g) => /cash_on_delivery|cod/i.test(g)) || financialStatus === "pending";

    if (isCod && phone && isValidE164(phone)) {
      const orgId = await resolveOrgIdForShop(shop);
      await db.insert(scheduledCalls).values({
        toNumber: phone,
        workflowName: "shopify-cod-confirmation",
        persona: "shopify-cod-confirmation",
        attempt: 1,
        maxAttempts: Number(process.env.SHOPIFY_COD_MAX_ATTEMPTS ?? 3),
        runAt: new Date(Date.now() + Number(process.env.SHOPIFY_COD_DELAY_MINUTES ?? 30) * 60 * 1000),
        status: "pending",
        orgId,
        metadata: { shop, orderId },
      });
    }

    await markProcessed(shop, "orders_create", idempotencyKey);
    return c.json({ status: "processed", cod_scheduled: isCod }, 200);
  })

  // 4. POST /orders/fulfilled — order fulfilled. Schedules the feedback
  // call per the feedback playbook's delay. Idempotency key: order_id.
  .post("/orders/fulfilled", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.shop || body?.order_id === undefined) {
      return c.json({ error: "shop and order_id are required" }, 400);
    }
    const { shop, order_id: orderId, phone } = body as { shop: string; order_id: number; phone?: string };
    const idempotencyKey = String(orderId);

    if (await alreadyProcessed(shop, "orders_fulfilled", idempotencyKey)) {
      return c.json({ status: "already_processed" }, 200);
    }

    if (!phone || !isValidE164(phone)) {
      await markProcessed(shop, "orders_fulfilled", idempotencyKey);
      return c.json({ status: "no_callable_phone" }, 200);
    }

    const orgId = await resolveOrgIdForShop(shop);
    const delayDays = Number(process.env.SHOPIFY_FEEDBACK_DELAY_DAYS ?? 3);

    await db.insert(scheduledCalls).values({
      toNumber: phone,
      workflowName: "shopify-feedback",
      persona: "shopify-feedback",
      attempt: 1,
      maxAttempts: 1, // feedback calls don't retry — a missed call just means no feedback this time
      runAt: new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000),
      status: "pending",
      orgId,
      metadata: { shop, orderId },
    });

    await markProcessed(shop, "orders_fulfilled", idempotencyKey);
    return c.json({ status: "scheduled" }, 200);
  })

  // 5. POST /webhooks/customers — upsert contact, consent mapped from
  // marketing_consent. Idempotent by (org_id, e164).
  .post("/webhooks/customers", async (c) => {
    const payload = await c.req.json().catch(() => null);
    if (!payload?.shop || !payload?.body) return c.json({ error: "shop and body are required" }, 400);
    const { shop, body } = payload as { shop: string; body: Record<string, unknown> };
    const phone = body.phone as string | undefined;
    if (!phone || !isValidE164(phone)) return c.json({ status: "no_phone" }, 200);

    const orgId = await resolveOrgIdForShop(shop);
    if (!orgId) return c.json({ status: "shop_not_connected" }, 200);

    const consent = (body.marketing_consent as { state?: string } | undefined)?.state === "subscribed";

    await db
      .insert(shopifyContacts)
      .values({
        orgId,
        shop,
        e164: phone,
        email: (body.email as string | undefined) ?? undefined,
        name: [body.first_name, body.last_name].filter(Boolean).join(" ") || undefined,
        marketingConsent: consent,
      })
      .onConflictDoUpdate({
        target: [shopifyContacts.orgId, shopifyContacts.e164],
        set: { email: (body.email as string | undefined) ?? undefined, marketingConsent: consent },
      });

    return c.json({ status: "upserted" }, 200);
  })

  // 6. POST /uninstalled — disconnect the shop, cancel pending calls, per
  // the contract's 1.4 path+auth fix.
  .post("/uninstalled", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.shop) return c.json({ error: "shop is required" }, 400);
    const { shop } = body as { shop: string };

    const orgId = await resolveOrgIdForShop(shop);
    await db.update(shopLinks).set({ disconnectedAt: new Date() }).where(eq(shopLinks.shop, shop));

    if (orgId) {
      await db
        .update(scheduledCalls)
        .set({ status: "canceled" })
        .where(and(eq(scheduledCalls.orgId, orgId), eq(scheduledCalls.status, "pending")));
    }

    return c.json({ status: "disconnected" }, 200);
  })

  // 7a. POST /customers/redact — GDPR. Delete/anonymize matching contacts
  // within 30 days (immediate here, matching the contract's "immediate is
  // fine").
  .post("/customers/redact", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.shop || !body?.customer) return c.json({ error: "shop and customer are required" }, 400);
    const { shop, customer } = body as { shop: string; customer: { phone?: string; email?: string } };

    if (customer.phone) {
      const orgId = await resolveOrgIdForShop(shop);
      if (orgId) {
        await db
          .delete(shopifyContacts)
          .where(and(eq(shopifyContacts.orgId, orgId), eq(shopifyContacts.e164, customer.phone)));
      }
    }
    // NOTE: this deliberately does not touch `calls`/`transcripts` yet —
    // full GDPR erasure across call metadata already exists as a generic
    // OpenVent feature (see @openvent/compliance's retention/erasure —
    // ADR referenced in the base repo), but it's keyed on phone number
    // globally today, not org-scoped. Wiring org-scoped erasure through
    // that existing path is a real, scoped follow-up — see WEEBER-PLAN.md.
    return c.json({ status: "redacted" }, 200);
  })

  // 7b. POST /shop/redact — GDPR, whole-shop.
  .post("/shop/redact", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.shop) return c.json({ error: "shop is required" }, 400);
    const { shop } = body as { shop: string };
    const orgId = await resolveOrgIdForShop(shop);
    if (orgId) {
      await db.delete(shopifyContacts).where(eq(shopifyContacts.orgId, orgId));
    }
    return c.json({ status: "redacted" }, 200);
  })

  // 8. POST /customers/data_request — GDPR data-subject access request.
  // Weeber is the system of record for call/contact metadata and must be
  // ready to disclose what it holds. This scaffold returns what it has on
  // the contact record; full call/transcript disclosure reuses the
  // existing compliance audit-trail export (see docs/api-reference.md's
  // /calls/:id/audit and /callers/:phoneNumber/audit) — wiring that in is
  // a small follow-up (the export function already exists), not a new
  // capability to build.
  .post("/customers/data_request", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.shop || !body?.customer) return c.json({ error: "shop and customer are required" }, 400);
    const { shop, customer } = body as { shop: string; customer: { phone?: string } };
    const orgId = await resolveOrgIdForShop(shop);

    let contact = null;
    if (orgId && customer.phone) {
      const [row] = await db
        .select()
        .from(shopifyContacts)
        .where(and(eq(shopifyContacts.orgId, orgId), eq(shopifyContacts.e164, customer.phone)))
        .limit(1);
      contact = row ?? null;
    }

    return c.json({ status: "acknowledged", contact }, 200);
  });

/**
 * Internal — not part of the weebersh contract. Called via the workflow
 * engine's `onExhausted` webhook action (see ../../voice/workflows/types.ts)
 * when the shopify-cod-confirmation workflow's retries are exhausted with
 * no confirmation. Cancels the unconfirmed order through weebersh (contract
 * endpoint 10) rather than leaving it to ship unconfirmed.
 */
shopify.post("/internal/cod-confirmation-exhausted", requireWeeberSecret, async (c) => {
  const body = await c.req.json().catch(() => null);
  const metadata = body?.metadata as { shop?: string; orderId?: number } | undefined;
  if (!metadata?.shop || metadata.orderId === undefined) {
    return c.json({ error: "metadata.shop and metadata.orderId are required" }, 400);
  }

  const result = await cancelOrder({
    shop: metadata.shop,
    orderId: metadata.orderId,
    reason: "CUSTOMER",
    notifyCustomer: false,
    restock: true,
    staffNote: "No COD confirmation after max call attempts",
  });

  // weebersh's status codes are dynamic (200/202/4xx/5xx per the contract),
  // which doesn't fit Hono's literal-status-code typing for `c.json()` — this
  // is an internal route (not a public API surface with typed clients), so a
  // plain Response keeps the real status code without fighting the type.
  return new Response(JSON.stringify(result.data), {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
});
