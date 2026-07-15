/**
 * Outgoing webhook dispatch — fires call lifecycle events to an external
 * automation tool (n8n, Zapier, Make, etc). Uses an outbox pattern: events
 * are durably persisted before delivery is attempted, with automatic retry
 * and dead-letter handling. Never blocks or fails the call flow.
 *
 * Resolution order for the target URL: per-call override (passed when
 * triggering an outbound call, or stored on the call row) > WEBHOOK_URL env
 * var (global default) > no-op if neither is set.
 */
import { db } from "../database";
import { webhookOutbox } from "../database/schema";
import { eq, and, lte, inArray } from "drizzle-orm";

export type VoiceWebhookEvent =
  | "call.started"
  | "call.transcript"
  | "call.tool_call"
  | "call.completed"
  | "call.recording_ready"
  | "call.retries_exhausted"
  | "call.voicemail_detected";

export function resolveWebhookUrl(perCallUrl?: string | null) {
  return perCallUrl || process.env.WEBHOOK_URL || null;
}

/**
 * Enqueues a webhook event in the outbox for reliable delivery.
 * The delivery worker (see webhook-delivery.ts) picks these up and
 * attempts delivery with retry + exponential backoff.
 */
export async function dispatchWebhook(
  targetUrl: string | null | undefined,
  event: VoiceWebhookEvent,
  data: Record<string, unknown>,
  orgId?: string | null,
) {
  if (!targetUrl) return;

  await db.insert(webhookOutbox).values({
    orgId: orgId ?? null,
    eventType: event,
    payload: { event, timestamp: new Date().toISOString(), data },
    targetUrl,
    status: "pending",
    nextRetryAt: new Date(),
  }).catch((err) => {
    console.error(`[webhook] failed to enqueue ${event} to outbox`, err);
  });
}

const BACKOFF_SECONDS = [30, 120, 600, 3600, 21600];

/**
 * Delivery worker — called on a periodic sweep (same pattern as the scheduler).
 * Claims pending/retry-due rows, attempts delivery, handles success/failure.
 */
export async function processWebhookOutbox(batchSize = 10): Promise<number> {
  const now = new Date();
  const due = await db
    .select()
    .from(webhookOutbox)
    .where(
      and(
        inArray(webhookOutbox.status, ["pending", "failed"]),
        lte(webhookOutbox.nextRetryAt, now),
      ),
    )
    .limit(batchSize);

  let delivered = 0;

  for (const row of due) {
    // Claim via CAS — set status to 'delivering' only if still pending/failed
    const claimed = await db
      .update(webhookOutbox)
      .set({ status: "delivering" })
      .where(
        and(
          eq(webhookOutbox.id, row.id),
          inArray(webhookOutbox.status, ["pending", "failed"]),
        ),
      )
      .returning({ id: webhookOutbox.id });
    if (claimed.length === 0) continue;

    try {
      const res = await fetch(row.targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        await db
          .update(webhookOutbox)
          .set({ status: "delivered", deliveredAt: new Date(), attempts: row.attempts + 1 })
          .where(eq(webhookOutbox.id, row.id));
        delivered++;
      } else {
        await markFailed(row.id, row.attempts, `HTTP ${res.status}`, row.maxAttempts);
      }
    } catch (err) {
      await markFailed(row.id, row.attempts, (err as Error).message, row.maxAttempts);
    }
  }

  return delivered;
}

async function markFailed(id: number, attempts: number, error: string, maxAttempts: number) {
  const newAttempts = attempts + 1;
  const isDead = newAttempts >= maxAttempts;
  const backoffIdx = Math.min(newAttempts - 1, BACKOFF_SECONDS.length - 1);
  const nextRetry = new Date(Date.now() + BACKOFF_SECONDS[backoffIdx] * 1000);

  await db
    .update(webhookOutbox)
    .set({
      status: isDead ? "dead" : "failed",
      attempts: newAttempts,
      lastError: error.slice(0, 500),
      nextRetryAt: isDead ? nextRetry : nextRetry,
    })
    .where(eq(webhookOutbox.id, id));
}
