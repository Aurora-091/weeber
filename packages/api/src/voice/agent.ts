import { streamText, stepCountIs, type ModelMessage } from "ai";
import dedent from "dedent";
import { lookupInfo } from "./tools/lookupInfo";
import { bookAppointment } from "./tools/bookAppointment";
import { setDisposition } from "./tools/setDisposition";
import { crmSync } from "./tools/crmSync";
import { captureField } from "./tools/captureField";
import { withDisclosure } from "@openvent/compliance";
import { resolveVoiceModel, getActiveModelLabel } from "./llm";

const DEFAULT_PERSONA = dedent`
  You are OpenVent, a warm, sharp voice assistant answering a live phone call.

  What OpenVent is, in case the caller asks about you or the product you run on:
  OpenVent is a self-hosted voice pipeline — the open alternative to black-box
  voice AI platforms. The person running this owns the code, the database,
  and the call logic on their own infrastructure. The phone call itself
  runs through Twilio and the speech-to-text through Deepgram, same as
  anyone building this would use — those stay real cloud services, nobody
  runs their own phone network. What's different from a rented platform is
  the owner picked every piece themselves, can swap any of them freely, and
  every recording and transcript lands in their own database, not a
  vendor's dashboard. Keep this brief and honest if it comes up — don't
  oversell it as more self-contained than it is.

  How you talk:
  - You are heard, not read — every reply is spoken aloud via text-to-speech.
    Keep sentences short and conversational. Never use markdown, bullet lists,
    numbered lists, or symbols like asterisks or hashes — say things the way a
    person would say them out loud.
  - Ask one question at a time, then stop and actually wait for the answer.
  - Keep replies brief by default — a sentence or two — unless the caller
    clearly wants detail.
  - Always say something. Never go silent — if you're unsure what to say,
    say what you do know and ask a clarifying question rather than pausing.
  - If you don't know something specific and no tool can answer it, say so
    plainly and offer the next best step. Never invent facts, prices, names,
    or times you don't actually have.
  - If the caller talks over you, that's expected — let it happen naturally
    and pick up from what they actually said.

  Your job on this call:
  - Figure out what the caller needs in the first exchange or two.
  - Use your tools only for things you genuinely don't know (specific lookups,
    booking actions) — you already know what OpenVent is, so answer that directly
    without calling a tool.
  - If the call is going nowhere or the caller wants a human, say so honestly
    and let them know you'll flag it — don't stall.
`;

/**
 * Optional per-Twilio-number persona overrides, so different phone numbers
 * can carry different agent personalities without a redeploy. Configure via
 * the AGENT_PERSONAS env var — a JSON object mapping E.164 numbers to a
 * system prompt string, e.g.:
 *   AGENT_PERSONAS={"+15551234567": "You are a scheduling assistant for..."}
 * Falls back to DEFAULT_PERSONA when no match is found or the env var is unset.
 */
function loadPersonaMap(): Record<string, string> {
  const raw = process.env.AGENT_PERSONAS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch (err) {
    console.error("[voice-agent] AGENT_PERSONAS is not valid JSON — ignoring", err);
    return {};
  }
}

const personaMap = loadPersonaMap();

/** Resolve the persona for a call: explicit override > per-number config > default. */
export function resolvePersona(explicitPersona?: string, calledNumber?: string): string {
  const base =
    explicitPersona ?? (calledNumber && personaMap[calledNumber]) ?? DEFAULT_PERSONA;
  // Compliance: automatically inject the recording/AI disclosure instruction
  // into whichever persona is active — enforced by default, not opt-in.
  return withDisclosure(base);
}

export const voiceTools = { lookupInfo, bookAppointment, setDisposition, crmSync, captureField };

/**
 * Renders the current structured call state as a compact, explicit block the
 * model reads as ground truth — separate from (and prioritized over) the raw
 * transcript. This is the fix for the "asks for the same info twice" failure
 * mode: the model is told what's already known instead of being expected to
 * re-derive it from scrollback. Empty state renders nothing (no block at all)
 * so it never pollutes the prompt on calls with nothing captured yet.
 */
export function buildKnownFactsBlock(capturedState?: Record<string, string>): string {
  const entries = Object.entries(capturedState ?? {});
  if (entries.length === 0) return "";
  const lines = entries.map(([field, value]) => `- ${field}: ${value}`).join("\n");
  return dedent`


    Known facts about this call — already confirmed, do not ask for these again:
    ${lines}
  `;
}

/**
 * Renders rolling cross-call memory (ADR-023) as prior-call context — clearly
 * labeled as "from a previous call" so the model doesn't conflate it with
 * `buildKnownFactsBlock`'s this-call facts (which it's allowed to treat as
 * settled ground truth for the live call). Prior-call memory is context, not
 * a confirmed fact for *this* call — the model should still confirm anything
 * safety- or accuracy-critical rather than assume it still holds.
 */
export function buildCallerMemoryBlock(callerMemory?: Record<string, string>): string {
  const entries = Object.entries(callerMemory ?? {});
  if (entries.length === 0) return "";
  const lines = entries.map(([field, value]) => `- ${field}: ${value}`).join("\n");
  return dedent`


    This caller has called before. From a previous call (may be outdated — confirm before relying on it):
    ${lines}
  `;
}

// If the model produces no text at all for a turn (e.g. gets stuck only
// calling tools, or the provider returns empty output), we still need to say
// *something* — dead air on a live call reads as a dropped connection.
const FALLBACK_REPLY = "Sorry, I didn't quite catch that — could you say that again?";

// Hard ceiling per turn so a stuck generation can never hang the call
// indefinitely. Twilio's own low-level timeouts would eventually kill the
// call anyway, but we want to recover gracefully well before that happens.
const TURN_TIMEOUT_MS = 12_000;

/**
 * Runs one agent turn for a live call, streaming text deltas as they arrive so
 * the caller can hear the response as fast as possible (fed sentence-by-sentence
 * into TTS by the caller of this function). Guarantees non-empty output and a
 * bounded turn duration — a turn that produces nothing or takes too long
 * still ends with a spoken fallback instead of silence.
 */
export async function runVoiceAgentTurn({
  history,
  persona,
  onTextDelta,
  onToolCall,
  signal,
  onLatency,
  llmProvider,
  capturedState,
  callerMemory,
}: {
  history: ModelMessage[];
  persona?: string;
  onTextDelta: (delta: string) => void;
  onToolCall?: (name: string, input: unknown, output: unknown) => void;
  signal?: AbortSignal;
  /** Reports time-to-first-token, useful for comparing LLM providers (see llm/). */
  onLatency?: (ms: number, model: string) => void;
  /** Per-call override of the global LLM_PROVIDER — see session-store.ts. */
  llmProvider?: "gateway" | "groq";
  /** Structured facts captured so far this call — appended to the system
   * prompt as ground truth (see buildKnownFactsBlock). */
  capturedState?: Record<string, string>;
  /** Rolling facts from previous calls with this same number (ADR-023) — see buildCallerMemoryBlock. */
  callerMemory?: Record<string, string>;
}): Promise<string> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), TURN_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  const turnStartedAt = Date.now();
  let firstTokenAt: number | null = null;

  try {
    const result = streamText({
      model: resolveVoiceModel(llmProvider),
      system:
        (persona ?? DEFAULT_PERSONA) +
        buildCallerMemoryBlock(callerMemory) +
        buildKnownFactsBlock(capturedState),
      messages: history,
      tools: voiceTools,
      stopWhen: stepCountIs(6),
      abortSignal: combinedSignal,
      onStepFinish: (step) => {
        for (const call of step.toolCalls ?? []) {
          const result = step.toolResults?.find((r) => r.toolCallId === call.toolCallId);
          onToolCall?.(call.toolName, call.input, result?.output);
        }
      },
    });

    let full = "";
    for await (const delta of result.textStream) {
      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
        onLatency?.(firstTokenAt - turnStartedAt, getActiveModelLabel(llmProvider));
      }
      full += delta;
      onTextDelta(delta);
    }

    // The model ran (possibly called tools) but produced no spoken text —
    // say something rather than leaving the caller in silence.
    if (!full.trim() && !signal?.aborted) {
      onTextDelta(FALLBACK_REPLY);
      return FALLBACK_REPLY;
    }

    return full;
  } catch (err) {
    // If we hit our own timeout (not a real barge-in abort from the caller),
    // still give the caller something to hear instead of dead air.
    if (timeoutController.signal.aborted && !signal?.aborted) {
      console.warn("[voice-agent] turn exceeded timeout — using fallback reply");
      onTextDelta(FALLBACK_REPLY);
      return FALLBACK_REPLY;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generates the agent's opening line the moment a call connects, so callers
 * aren't met with silence while waiting for Deepgram to hear them speak first.
 * Runs as a normal agent turn with an instruction to open the conversation.
 */
export function runVoiceAgentGreeting({
  persona,
  onTextDelta,
  signal,
  capturedState,
  onLatency,
  callerMemory,
}: {
  persona?: string;
  onTextDelta: (delta: string) => void;
  signal?: AbortSignal;
  /** Pre-seeded facts (e.g. from a CRM/workflow before an outbound call connects). */
  capturedState?: Record<string, string>;
  /** Reports time-to-first-token — the greeting is usually the first turn of the call, so this is
   * typically what feeds the call-level LLM TTFT metric (see stream.ts's callLatency capture). */
  onLatency?: (ms: number, model: string) => void;
  /** Rolling facts from previous calls with this same number (ADR-023). */
  callerMemory?: Record<string, string>;
}) {
  return runVoiceAgentTurn({
    history: [
      {
        role: "user",
        content: "[The call has just connected. Greet the caller briefly and ask how you can help.]",
      },
    ],
    persona,
    onTextDelta,
    signal,
    capturedState,
    onLatency,
    callerMemory,
  });
}
