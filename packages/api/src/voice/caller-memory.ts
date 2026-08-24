/**
 * Cross-call memory (ADR-023) — a rolling, per-org, per-phone-number fact
 * overlay, alongside (not replacing) the per-call `capturedState` engine
 * (ADR-012).
 *
 * Deliberately the simplest version that solves "the agent doesn't remember
 * me from last time": a flat key/value merge, stored as JSON, no LLM
 * summarization call and no separate history log to keep bounded. A field
 * captured on call 1 survives into call 5's prompt unless a later call
 * overwrites it with a new value for the same key.
 *
 * Scoped by `orgId` (audit #01, D2) — the same phone number can call two
 * different Weeber users, and memory (and its erasure) must not leak
 * across that boundary. `orgId` is `""` for single-tenant/self-hosted usage with
 * no org concept — see the schema comment on `callerMemory` for why that's
 * `""` and not `undefined`/`NULL`.
 */
import { db } from "../database";
import { callerMemory, type CapturedField } from "../database/schema";
import { and, eq } from "drizzle-orm";
import { withRetry } from "../database/with-retry";

function normalizeOrgId(orgId: string | undefined | null): string {
  return orgId ?? "";
}

export async function getCallerMemory(orgId: string | undefined, phoneNumber: string): Promise<Record<string, CapturedField>> {
  if (!phoneNumber) return {};
  const scopedOrgId = normalizeOrgId(orgId);
  const [row] = await db
    .select()
    .from(callerMemory)
    .where(and(eq(callerMemory.orgId, scopedOrgId), eq(callerMemory.phoneNumber, phoneNumber)))
    .limit(1);
  return row?.facts ?? {};
}

/**
 * Merges this call's captured facts into the caller's rolling memory for
 * this org. A no-op if nothing was captured this call — a returning caller
 * with no new facts doesn't need a write, and we don't want to churn
 * `updatedAt` for calls that added nothing.
 */
export async function upsertCallerMemory(
  orgId: string | undefined,
  phoneNumber: string,
  capturedThisCall: Record<string, CapturedField>,
  callId: number,
): Promise<void> {
  // A2 (phase-a-integrity.md): `markFieldUnanswered` writes `value: null` —
  // "asked, no answer" — into THIS call's capturedState. That's per-call
  // state, not a durable fact about the caller, so it must not carry forward
  // into cross-call memory: a caller who evaded a question on call 3 may well
  // answer it plainly on call 4, and a stale "unanswered" entry sitting in
  // memory would give buildCallerMemoryBlock nothing useful to render (see its
  // own defensive filter) while permanently occupying the field's key.
  const confirmedThisCall = Object.fromEntries(
    Object.entries(capturedThisCall).filter(([, entry]) => entry.value !== null),
  );
  if (!phoneNumber || Object.keys(confirmedThisCall).length === 0) return;

  const scopedOrgId = normalizeOrgId(orgId);
  const existing = await getCallerMemory(scopedOrgId, phoneNumber);
  const merged = { ...existing, ...confirmedThisCall };

  await withRetry(
    () =>
      db
        .insert(callerMemory)
        .values({ orgId: scopedOrgId, phoneNumber, facts: merged, lastCallId: callId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [callerMemory.orgId, callerMemory.phoneNumber],
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
