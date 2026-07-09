/**
 * Cross-call memory (ADR-023) — a rolling, per-phone-number fact overlay,
 * alongside (not replacing) the per-call `capturedState` engine (ADR-012).
 *
 * Deliberately the simplest version that solves "the agent doesn't remember
 * me from last time": a flat key/value merge, stored as JSON, no LLM
 * summarization call and no separate history log to keep bounded. A field
 * captured on call 1 survives into call 5's prompt unless a later call
 * overwrites it with a new value for the same key.
 */
import { db } from "../database";
import { callerMemory } from "../database/schema";
import { eq } from "drizzle-orm";
import { withRetry } from "../database/with-retry";

export async function getCallerMemory(phoneNumber: string): Promise<Record<string, string>> {
  if (!phoneNumber) return {};
  const [row] = await db.select().from(callerMemory).where(eq(callerMemory.phoneNumber, phoneNumber)).limit(1);
  return row?.facts ?? {};
}

/**
 * Merges this call's captured facts into the caller's rolling memory.
 * A no-op if nothing was captured this call — a returning caller with no
 * new facts doesn't need a write, and we don't want to churn `updatedAt`
 * for calls that added nothing.
 */
export async function upsertCallerMemory(
  phoneNumber: string,
  capturedThisCall: Record<string, string>,
  callId: number,
): Promise<void> {
  if (!phoneNumber || Object.keys(capturedThisCall).length === 0) return;

  const existing = await getCallerMemory(phoneNumber);
  const merged = { ...existing, ...capturedThisCall };

  await withRetry(
    () =>
      db
        .insert(callerMemory)
        .values({ phoneNumber, facts: merged, lastCallId: callId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: callerMemory.phoneNumber,
          set: { facts: merged, lastCallId: callId, updatedAt: new Date() },
        }),
    { label: "upsert-caller-memory" },
  ).catch((err) => console.error("[caller-memory] failed to persist", err));
}

/**
 * Which of a call's two numbers is "the human" — the caller on an inbound
 * call is `fromNumber`; on an outbound call, the human is who we dialed,
 * `toNumber`. (`fromNumber` on an outbound call is the operator's own Twilio
 * number, not a real person — never key memory off that.)
 */
export function resolveHumanNumber(direction: "inbound" | "outbound", fromNumber: string, toNumber: string): string {
  return direction === "inbound" ? fromNumber : toNumber;
}
