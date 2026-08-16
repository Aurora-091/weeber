import { eq, and } from "drizzle-orm";
// ADR-116 addendum: inbound Shopify webhook dedup check, never on a live
// call's turn path — uses the background connection pool.
import { dbBackground as db } from "../../database";
import { shopifyWebhookEvents } from "../../database/schema";

/**
 * The contract is explicit that delivery is at-least-once (Shopify retries
 * + weebersh's own retries) and "every endpoint must be idempotent." This
 * is the shared dedupe check every Shopify route runs before doing
 * anything with side effects (scheduling a call, upserting a contact,
 * issuing a discount) — first call to see a given (shop, topic,
 * idempotencyKey) wins; every retry after that is a no-op 200.
 *
 * Returns true if this event was already processed (caller should short-
 * circuit and return success without repeating the side effect), false if
 * this is the first time seeing it (caller should proceed, then rely on
 * the unique index racing safely — see note below).
 */
export async function alreadyProcessed(shop: string, topic: string, idempotencyKey: string): Promise<boolean> {
  const existing = await db
    .select({ id: shopifyWebhookEvents.id })
    .from(shopifyWebhookEvents)
    .where(
      and(
        eq(shopifyWebhookEvents.shop, shop),
        eq(shopifyWebhookEvents.topic, topic),
        eq(shopifyWebhookEvents.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return existing.length > 0;
}

/**
 * Marks an event processed. Call this *after* the side effect succeeds, not
 * before — if the process crashes mid-side-effect, we want the retry to
 * still see "not processed" and try again, not silently skip it forever.
 * The table's unique index (shop, topic, idempotencyKey) is the actual
 * safety net against a genuine race between two concurrent retries; this
 * insert is expected to occasionally fail with a unique-constraint error
 * in that case, which the caller should treat as "someone else already
 * finished this," not as a real error.
 */
export async function markProcessed(shop: string, topic: string, idempotencyKey: string): Promise<void> {
  await db.insert(shopifyWebhookEvents).values({ shop, topic, idempotencyKey }).onConflictDoNothing();
}
