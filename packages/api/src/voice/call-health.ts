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
  /**
   * Transcript rows attributed to the CALLER specifically (ADR-084).
   *
   * Separate from `transcriptCount` because the total cannot distinguish a real
   * conversation from the agent talking to itself: an agent that greeted,
   * monologued three turns and hung up on a caller who never got a word in
   * writes several transcript rows and looks fine by every other signal here.
   * Zero caller rows on an answered call means we have no evidence the caller
   * was ever heard, whatever the pipeline metrics say.
   */
  callerTranscriptCount: number;
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
  /**
   * B5 (phase-b-measurement.md): the worst (max) per-turn voice-to-voice
   * latency this call actually produced, from `turnLatency` rows — distinct
   * from `pickupToFirstAudioMs`/`llmTtftMs`/`ttsFirstByteMs` above, which are
   * all first-turn/call-level numbers. Both production calls' first turns
   * looked fine (call 2: 1585ms LLM TTFT) while a LATER turn was
   * catastrophic (call 2 turn 18: 4436ms) — a call-level-only view never
   * sees that turn at all. Undefined when no turn ever produced a
   * measurable voiceToVoiceMs (e.g. every turn aborted before TTS produced
   * audio).
   */
  maxTurnVoiceToVoiceMs?: number;
  /**
   * B5: whether A1/A2's provenance guard refused a fabricated capture this
   * call — production call 2's tobacco fabrication is the case this exists
   * for. A call that invented a fact is not healthy regardless of how fast
   * it was.
   */
  hadFabricatedCapture: boolean;
  /**
   * B5: whether A4's undelivered-outcome guardrail fired this call — a
   * `synced: false` CRM sync, or a `callback-requested` disposition with no
   * `scheduled_calls` row. A call that promised something it didn't deliver
   * is not healthy regardless of how fast it was.
   */
  hadUndeliveredOutcome: boolean;
}

export interface CallHealthResult {
  status: CallHealthStatus;
  /** Human-readable reasons, most relevant first. Empty for a clean healthy call. */
  reasons: string[];
}

/**
 * Dead air (pickup -> first agent audio) at or above this is a caller-visible
 * problem worth flagging as degraded.
 *
 * B5 (phase-b-measurement.md): recalibrated from 3000ms. The prior value sat
 * above BOTH production calls (1985ms, 2753ms) despite the audit measuring
 * them at 2.5-3.4x over the actual target — a threshold set above every
 * real sample it was supposed to catch was not a threshold, it was a no-op.
 * 1200ms is not an arbitrary tightening: it is Phase C's own committed
 * pickup-to-first-audio target (docs/plans/README.md's phase table,
 * `docs/plans/phase-c-latency.md`) — "degraded" now means the same thing as
 * "missed the bar the project already set for itself."
 */
export const DEAD_AIR_DEGRADED_MS = 1200;
/**
 * Dead air at or above this is effectively a silent failure — most callers
 * have given up or are convinced the line is dead by the time audio arrives.
 */
export const DEAD_AIR_SILENT_MS = 8000;
/**
 * LLM time-to-first-token at or above this is a degraded, sluggish turn —
 * checked against the call-level (first-turn) value. B5: left at 2500ms
 * deliberately, unlike the other thresholds below — neither production
 * call's FIRST turn was actually slow (1259ms, 1585ms); their slow turns
 * came later in the call, which is exactly why `maxTurnVoiceToVoiceMs` and
 * `MAX_TURN_V2V_DEGRADED_MS` exist below instead of just lowering this
 * number until it caught something it was never measuring.
 */
export const LLM_TTFT_DEGRADED_MS = 2500;
/**
 * STT connect at or above this delays the whole first turn — degraded.
 *
 * B5: recalibrated from 2000ms. The audit's own finding: "STT_CONNECT_
 * DEGRADED_MS did not fire on a 753ms connect" — i.e. 753ms was already a
 * defect worth flagging and the threshold sat nearly 3x above it. 700ms
 * catches call 2's 753ms connect without also flagging call 1's 608ms,
 * which the audit never called out — this is the narrowest change that
 * fixes the named case rather than a round-number guess.
 */
export const STT_CONNECT_DEGRADED_MS = 700;
/**
 * B5: the worst single turn's voice-to-voice latency at or above this is
 * degraded, even when every other signal (including the call-level
 * first-turn numbers above) looks fine. Both production calls' worst turns
 * (4031ms, 4846ms) are close to 4x Phase C's 1100ms p50 target
 * (docs/plans/README.md) — 3000ms sits meaningfully above that target
 * (there is room for one genuinely slow turn in an otherwise fine call
 * before this fires) while still catching both real cases with margin.
 */
export const MAX_TURN_V2V_DEGRADED_MS = 3000;

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
  // ADR-084: the agent held a conversation the caller was never heard in. The
  // agent got past its greeting (so this is not the greeting-only case below)
  // and produced audio, yet not one caller utterance was ever transcribed.
  // Either STT silently stopped delivering finals, or the agent talked over /
  // hung up on the caller. Both are silent failures: every latency metric on
  // such a call is green.
  if (
    input.callerTranscriptCount === 0 &&
    input.turnCount > 1 &&
    input.ttsFirstByteMs !== undefined
  ) {
    silent.push(
      `agent took ${input.turnCount} turns but the caller was never transcribed — one-sided call`,
    );
  }
  // ADR-084: an outcome recorded on a call the caller never spoke in is a
  // FABRICATED outcome. This is the most dangerous row shape in the system:
  // it is counted as a success by every funnel/disposition dashboard, so it
  // inflates exactly the pilot metrics a customer is judging us on, and a
  // "booked"/"qualified" disposition here can push a lead to a human closer
  // with facts no caller ever confirmed. Flagged even when turnCount is low,
  // because the disposition — not the turn count — is what makes it harmful.
  if (input.hadDisposition && input.callerTranscriptCount === 0) {
    silent.push(
      "an outcome was recorded but the caller was never transcribed — the disposition is not evidence-backed",
    );
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
  // B5 (phase-b-measurement.md): "a call that fabricated a field or promised
  // an undelivered callback is not healthy, whatever its latencies" — the
  // plan's own words. Both are data-integrity defects, not pipeline slowness,
  // and both are worse than any latency number: a fast call that invented a
  // fact or silently failed to deliver its outcome is more dangerous than a
  // slow one, because every other signal on it looks clean.
  if (input.hadFabricatedCapture) {
    silent.push("a captureField write was refused as fabricated — the model invented a fact this call");
  }
  if (input.hadUndeliveredOutcome) {
    silent.push("an outcome this call reported (a sync or a promised callback) was not actually delivered");
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
  // B5: the call-level LLM/TTS numbers above are first-turn only and can
  // look fine while a later turn was catastrophic — this is the signal that
  // actually catches that shape.
  if (input.maxTurnVoiceToVoiceMs !== undefined && input.maxTurnVoiceToVoiceMs >= MAX_TURN_V2V_DEGRADED_MS) {
    degraded.push(`at least one turn was very slow: ${input.maxTurnVoiceToVoiceMs}ms voice-to-voice`);
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
