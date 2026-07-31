/**
 * Call-health classification (Five Bets Phase II, 2026-07-31).
 *
 * WHY THIS EXISTS
 * ---------------
 * Today a call row's `status` only tells us how the call *ended* from the
 * telephony layer's point of view (completed / failed / transferred). It does
 * NOT tell us whether the caller actually got a working agent. The failure we
 * cannot currently see is the *silent failure*: the call connects, `status`
 * lands on "completed", every dashboard counts it as a normal call — but the
 * caller heard dead air because the pipeline never produced audio, STT never
 * connected, or the agent greeted and then nothing followed. Those calls look
 * identical to healthy ones in every existing view.
 *
 * This module derives a health verdict from signals we already capture during
 * the call (latency metrics, turn count, transcript presence, reconnect/
 * failover counters). It is a PURE function of its input on purpose:
 *   - no DB, no clock, no I/O — trivially unit-testable and deterministic;
 *   - the caller (stream.ts finalizeCall) gathers the raw signals and hands
 *     them in, then persists the verdict onto the calls row.
 *
 * This is Phase II of the approved Five Bets plan and it is deliberately the
 * phase that GENERATES the evidence Phase V (semantic turn-detection) is gated
 * on. We do not build the fancy turn model until this health data shows a real
 * turn-taking problem in production.
 *
 * SCOPE / NON-GOALS
 * -----------------
 * - We only judge calls that were actually ANSWERED (media stream started). A
 *   call that never connected (no-answer/busy/failed dial) is not a pipeline
 *   health problem — it returns "healthy" with no reasons, because there was
 *   no live pipeline to fail. Dial-outcome lives in `status`/`disposition`.
 * - Thresholds here are first-pass and named as constants so they can be
 *   tuned once real distributions land, without touching the logic shape.
 */

/** Final telephony status of the call, as written to `calls.status`. */
export type CallFinalStatus = "completed" | "failed" | "transferred" | (string & {});

export type CallHealthStatus = "healthy" | "degraded" | "silent-failure";

export interface CallHealthInput {
  /** `calls.status` at finalize time. */
  finalStatus: CallFinalStatus;
  /** Did the media stream ever start (as close as we get to "call answered")? */
  answered: boolean;
  /**
   * Number of agent turns actually taken on this call (greeting counts as
   * turn 0). Derive from stream.ts's `turnCounter`: `Math.max(0, turnCounter + 1)`.
   * 0 means the agent never spoke a single turn.
   */
  turnCount: number;
  /** Total transcript rows written for this call (both roles). */
  transcriptCount: number;
  /** Did the agent record an outcome via setDisposition? */
  hadDisposition: boolean;
  /** First STT-connect latency (ms). Undefined = STT never connected. */
  sttConnectMs?: number;
  /** LLM time-to-first-token (ms). Undefined = LLM never produced a token. */
  llmTtftMs?: number;
  /** TTS first-audio-byte latency (ms). Undefined = agent never produced audio. */
  ttsFirstByteMs?: number;
  /** Caller-perceived pickup-to-first-word dead air (ms). */
  pickupToFirstAudioMs?: number;
  /** Same-provider STT reconnects mid-call. */
  sttReconnectCount: number;
  /** Cross-provider STT/TTS failovers mid-call. */
  providerFailoverCount: number;
}

export interface CallHealthResult {
  status: CallHealthStatus;
  /** Human-readable reasons, most relevant first. Empty for a clean healthy call. */
  reasons: string[];
}

/**
 * Dead air (pickup -> first agent audio) at or above this is a caller-visible
 * problem worth flagging as degraded.
 */
export const DEAD_AIR_DEGRADED_MS = 3000;
/**
 * Dead air at or above this is effectively a silent failure — most callers
 * have given up or are convinced the line is dead by the time audio arrives.
 */
export const DEAD_AIR_SILENT_MS = 8000;
/** LLM time-to-first-token at or above this is a degraded, sluggish turn. */
export const LLM_TTFT_DEGRADED_MS = 2500;
/** STT connect at or above this delays the whole first turn — degraded. */
export const STT_CONNECT_DEGRADED_MS = 2000;

/**
 * Classify a finalized call's pipeline health. Pure and deterministic.
 *
 * Severity escalates: silent-failure > degraded > healthy. We collect reasons
 * into severity buckets and return the highest bucket that has any reason,
 * with ALL of that verdict's reasons attached (a call can be silent for more
 * than one reason at once).
 */
export function classifyCallHealth(input: CallHealthInput): CallHealthResult {
  // Calls that never connected have no live pipeline to judge. Their outcome
  // is a dial result (status/disposition), not a health signal.
  if (!input.answered) {
    return { status: "healthy", reasons: [] };
  }

  const silent: string[] = [];
  const degraded: string[] = [];

  // ---- silent-failure signals -------------------------------------------
  // The agent never produced any audio at all on an answered call.
  if (input.ttsFirstByteMs === undefined && input.turnCount === 0) {
    silent.push("answered but the agent never produced any audio");
  }
  // STT never connected, so the caller's speech was never heard.
  if (input.sttConnectMs === undefined && input.turnCount === 0) {
    silent.push("STT never connected — the pipeline did not start");
  }
  // Nothing was ever said by anyone despite the call connecting.
  if (input.transcriptCount === 0 && input.ttsFirstByteMs === undefined) {
    silent.push("no transcript and no agent audio — call was empty");
  }
  // Dead air so long the caller almost certainly perceived a dead line.
  if (
    input.pickupToFirstAudioMs !== undefined &&
    input.pickupToFirstAudioMs >= DEAD_AIR_SILENT_MS
  ) {
    silent.push(
      `${input.pickupToFirstAudioMs}ms of dead air before first audio (>= ${DEAD_AIR_SILENT_MS}ms)`,
    );
  }

  // ---- degraded signals -------------------------------------------------
  // Slow but present first audio.
  if (
    input.pickupToFirstAudioMs !== undefined &&
    input.pickupToFirstAudioMs >= DEAD_AIR_DEGRADED_MS &&
    input.pickupToFirstAudioMs < DEAD_AIR_SILENT_MS
  ) {
    degraded.push(`slow first audio: ${input.pickupToFirstAudioMs}ms to first word`);
  }
  if (input.llmTtftMs !== undefined && input.llmTtftMs >= LLM_TTFT_DEGRADED_MS) {
    degraded.push(`slow LLM first token: ${input.llmTtftMs}ms`);
  }
  if (input.sttConnectMs !== undefined && input.sttConnectMs >= STT_CONNECT_DEGRADED_MS) {
    degraded.push(`slow STT connect: ${input.sttConnectMs}ms`);
  }
  if (input.sttReconnectCount > 0) {
    degraded.push(
      `STT reconnected ${input.sttReconnectCount} time(s) mid-call`,
    );
  }
  if (input.providerFailoverCount > 0) {
    degraded.push(
      `provider failover occurred ${input.providerFailoverCount} time(s)`,
    );
  }
  // Greeting-only call: agent spoke but the conversation never developed and
  // no outcome was recorded. Not silent (audio played) but not a real call.
  if (
    input.turnCount <= 1 &&
    !input.hadDisposition &&
    input.finalStatus === "completed" &&
    // only meaningful once we know at least the agent got as far as speaking
    input.ttsFirstByteMs !== undefined
  ) {
    degraded.push("agent greeted but no conversation followed and no outcome was recorded");
  }
  // A call that ended in a failed state after connecting is, at minimum, a
  // degraded experience (mid-call crash) if it wasn't already flagged silent.
  if (input.finalStatus === "failed") {
    degraded.push("call ended in a failed state after connecting");
  }

  if (silent.length > 0) {
    // Surface degraded reasons too — they add color to WHY it was silent.
    return { status: "silent-failure", reasons: [...silent, ...degraded] };
  }
  if (degraded.length > 0) {
    return { status: "degraded", reasons: degraded };
  }
  return { status: "healthy", reasons: [] };
}
