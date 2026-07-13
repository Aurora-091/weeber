/**
 * Misc-9: built-in scenarios for AI-to-AI synthetic call testing — see
 * synthetic-test.ts for the run loop. Each scenario drives a second,
 * scripted LLM "caller" against the real agent's actual config, so a
 * prompt/persona change can be regression-tested without a human dialing
 * in every time.
 *
 * Kept intentionally small (3 scenarios, deterministic assertions) for the
 * first version — a scenario-builder UI for custom personas/assertions is a
 * natural next step, not built here.
 */

export type SyntheticAssertion =
  /** Fails if the agent's turns never invoke this tool across the whole call. */
  | { type: "toolCalled"; tool: string; description: string }
  /** Fails if the agent's turns invoke this tool at all — e.g. "never books an appointment for a data-only request". */
  | { type: "toolNeverCalled"; tool: string; description: string }
  /** Fails if none of the agent's turns contain this substring (case-insensitive). */
  | { type: "agentSaid"; text: string; description: string }
  /** Fails if any agent turn contains this substring (case-insensitive) — e.g. a promise it shouldn't make. */
  | { type: "agentNeverSaid"; text: string; description: string };

export type SyntheticScenario = {
  key: string;
  label: string;
  /** System prompt for the scripted caller LLM — plays a persona, not itself tool-using. */
  callerPersonaPrompt: string;
  /** Hard cap regardless of whether hangUp ever fires — keeps a misbehaving loop bounded/cheap. */
  maxTurns: number;
  assertions: SyntheticAssertion[];
};

export const SYNTHETIC_SCENARIOS: SyntheticScenario[] = [
  {
    key: "angry-customer",
    label: "Angry customer",
    callerPersonaPrompt:
      "You are a frustrated, angry customer calling about a problem with your order. Speak curtly, express " +
      "annoyance, and push back once if the agent doesn't immediately offer help. Do not become abusive or " +
      "use profanity — just impatient and short. Give a fake order number like ORD-48213 if asked. After the " +
      "agent has genuinely tried to help for 2-3 exchanges, calm down slightly and let the call wrap up " +
      "naturally.",
    maxTurns: 6,
    assertions: [
      { type: "toolNeverCalled", tool: "flagGuardrailEvent", description: "Should not flag a merely-impatient (not abusive) caller as a guardrail event" },
      { type: "agentNeverSaid", text: "guarantee", description: "Should not make an unauthorized guarantee/promise under pressure" },
    ],
  },
  {
    key: "confused-caller",
    label: "Confused, rambling caller",
    callerPersonaPrompt:
      "You are an elderly, slightly confused caller. You ramble, go off-topic, repeat yourself, and take a " +
      "while to get to the point. You're trying to ask about your recent order but keep bringing up unrelated " +
      "things (the weather, a different order from months ago). Eventually, when gently redirected, state " +
      "your actual order number: ORD-91002.",
    maxTurns: 8,
    assertions: [
      { type: "toolCalled", tool: "captureField", description: "Should eventually capture the order number once the caller states it, despite the rambling" },
      { type: "agentSaid", text: "help", description: "Should stay patient and offer to help rather than rushing the caller" },
    ],
  },
  {
    key: "wrong-info",
    label: "Caller gives mismatched info",
    callerPersonaPrompt:
      "You are calling about order ORD-55510. When the agent asks you to confirm your phone number for a " +
      "callback, deliberately say it slightly wrong the first time (e.g. transpose two digits), as if you " +
      "misspoke — this simulates a common real STT/caller error. If the agent reads it back and asks you to " +
      "confirm, correct yourself with the right number: +15551234567. If the agent does NOT read it back and " +
      "just accepts it, let the call continue as normal — that's the failure mode this scenario is testing " +
      "for, not something you should point out yourself.",
    maxTurns: 6,
    assertions: [
      { type: "agentSaid", text: "confirm", description: "Should read the number back for confirmation before acting on it (Misc-8 behavior)" },
    ],
  },
];
