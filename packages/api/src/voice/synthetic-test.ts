/**
 * Misc-9: AI-to-AI synthetic call testing — a second, scripted LLM plays a
 * caller persona (see synthetic-scenarios.ts) and calls the real agent
 * end-to-end via text turns, so prompt/persona regressions can be caught
 * without a human dialing in every time.
 *
 * Text-only, not real audio/telephony — same reduced-fidelity tradeoff the
 * existing test-chat sandbox already makes (voice/STT/TTS timing and
 * barge-in behavior aren't exercised), in exchange for being cheap enough
 * to run on every persona edit. A voice-level version (both sides driven
 * through the actual STT/TTS pipeline) is a real next step, not built here
 * — flagged in WEEBER-PLAN.md as a larger, not-yet-scoped follow-up.
 *
 * Assertions are deterministic keyword/tool-call checks, not an LLM judge —
 * cheaper, reproducible, and good enough for the concrete failure modes
 * each scenario targets (see each scenario's assertion `description`).
 */
import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { resolveVoiceModel } from "./llm";
import { buildVoiceTools, buildKnownFactsBlock, GREETING_TURN_SEED, type ResolvedAgentConfig } from "./agent";
import type { SyntheticScenario, SyntheticAssertion } from "./synthetic-scenarios";

export type SyntheticTurn = { role: "caller" | "agent"; text: string };
export type SyntheticAssertionResult = { assertion: SyntheticAssertion; passed: boolean };

export type SyntheticTestResult = {
  scenarioKey: string;
  transcript: SyntheticTurn[];
  toolCallsByAgent: string[];
  /** ADR-103: "caller-silent" means the scripted caller model returned an empty
   * turn, so the run stopped with a shorter transcript than the scenario asked
   * for. It is almost always a persona bug (a purely reactive persona with
   * nothing yet to react to), not agent behaviour — and it is called out
   * explicitly because the previous silent `break` made such a run look
   * identical to a legitimate one that merely ran out of turns, which is how
   * the `wrong-info` scenario shipped broken and unnoticed.
   *
   * "caller-off-script" means the caller never said something the scenario's
   * `callerMustSay` requires, so the agent was never actually put in the
   * situation being tested. Such a run can never pass (`allPassed` is forced
   * false) — a boundary assertion the agent was never challenged on is not
   * evidence of anything. */
  endedBy: "hangup" | "max-turns" | "caller-silent" | "caller-off-script";
  assertions: SyntheticAssertionResult[];
  allPassed: boolean;
  /** ADR-103: `callerMustSay` phrases the scripted caller never actually said.
   * Non-empty means the run is invalid, not that the agent behaved well. */
  callerOffScript?: string[];
};

/**
 * The scripted caller's model. Overridable (ADR-103) because the caller side
 * has its own failure mode that has nothing to do with Weeber: an aligned
 * assistant model will refuse an adversarial persona and answer in its own
 * voice instead. Measured 2026-08-12 with the default below, the caller
 * replied "I can't provide or repeat highly sensitive personal or financial
 * identifiers..." and then offered the AGENT a bulleted list of insurance
 * topics — so the boundary scenarios never put the agent under test at all and
 * "passed" vacuously. `callerMustSay` (see synthetic-scenarios.ts) catches that
 * case; this override is how you fix it.
 */
const CALLER_MODEL = resolveVoiceModel(
  process.env.SYNTHETIC_CALLER_PROVIDER === "groq" ? "groq" : "gateway",
  process.env.SYNTHETIC_CALLER_MODEL || "openai/gpt-5.4-mini",
);

/** One caller-LLM turn — no tools, just plays the scripted persona given the
 * transcript so far (from the caller's point of view: agent turns are
 * "assistant" to the caller model, caller's own prior turns are "user"). */
async function runCallerTurn(
  callerPersonaPrompt: string,
  transcriptSoFar: SyntheticTurn[],
  callerModel: LanguageModel = CALLER_MODEL,
): Promise<string> {
  const messages: ModelMessage[] = transcriptSoFar.map((t) => ({
    role: t.role === "caller" ? "assistant" : "user",
    content: t.text,
  }));
  const result = streamText({
    model: callerModel,
    system: callerPersonaPrompt,
    messages: messages.length > 0 ? messages : [{ role: "user", content: "" }],
  });
  let text = "";
  for await (const delta of result.textStream) text += delta;
  return text.trim();
}

/** One real-agent turn — the actual system prompt/tools/model this org's
 * agent would use on a live call, same invocation shape as app/routes.ts's
 * test-chat handler. */
async function runAgentTurn(
  agentConfig: ResolvedAgentConfig,
  transcriptSoFar: SyntheticTurn[],
  orgId: string | undefined,
  /** ADR-103: agent-speaks-first mode. Seeds the same opening instruction a
   * live call uses (agent.ts's GREETING_TURN_SEED) so the outbound greeting
   * turn is exercised rather than paraphrased. Only meaningful on an empty
   * transcript. */
  seedGreeting = false,
): Promise<{ text: string; toolCalls: string[] }> {
  const model = resolveVoiceModel(agentConfig.llmProvider, agentConfig.llmModel);
  // A3b: same knowledge-base binding a live call gets — a scenario that
  // exercises lookupInfo tests against this org's real KB, not a stub.
  const tools = buildVoiceTools(orgId, agentConfig.enabledTools);
  const messages: ModelMessage[] = transcriptSoFar.map((t) => ({
    role: t.role === "agent" ? "assistant" : "user",
    content: t.text,
  }));
  if (seedGreeting && messages.length === 0) {
    messages.push({ role: "user", content: GREETING_TURN_SEED });
  }

  const toolCalls: string[] = [];
  const result = streamText({
    model,
    system: agentConfig.systemPrompt + buildKnownFactsBlock({}),
    messages,
    tools,
    stopWhen: stepCountIs(4),
    onStepFinish: (step) => {
      for (const call of step.toolCalls ?? []) toolCalls.push(call.toolName);
    },
  });
  let text = "";
  for await (const delta of result.textStream) text += delta;
  return { text: text.trim(), toolCalls };
}

/** Exported for unit testing — the LLM-driving loop above isn't cheaply
 * unit-testable without mocking `streamText`, but this scoring logic is
 * pure and deterministic. */
export function checkAssertion(assertion: SyntheticAssertion, transcript: SyntheticTurn[], toolCallsByAgent: string[]): boolean {
  const agentText = transcript
    .filter((t) => t.role === "agent")
    .map((t) => t.text.toLowerCase())
    .join(" ");
  switch (assertion.type) {
    case "toolCalled":
      return toolCallsByAgent.includes(assertion.tool);
    case "toolNeverCalled":
      return !toolCallsByAgent.includes(assertion.tool);
    case "toolCalledAnyOf":
      return assertion.tools.some((tool) => toolCallsByAgent.includes(tool));
    case "agentSaid":
      return agentText.includes(assertion.text.toLowerCase());
    case "agentNeverSaid":
      return !agentText.includes(assertion.text.toLowerCase());
  }
}

/** Punctuation- and case-insensitive, so a caller saying "412 88 7390" still
 * satisfies a required "412-88-7390". Exported for unit testing alongside
 * checkAssertion — same reason: the loop needs an LLM, this does not. */
export function findCallerOffScript(callerMustSay: string[] | undefined, transcript: SyntheticTurn[]): string[] {
  if (!callerMustSay?.length) return [];
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const callerText = normalize(transcript.filter((t) => t.role === "caller").map((t) => t.text).join(" "));
  return callerMustSay.filter((phrase) => !callerText.includes(normalize(phrase)));
}

/**
 * Runs one scenario to completion (hangUp tool call, or maxTurns reached)
 * and scores it against the scenario's assertions.
 *
 * Who opens the call is per-scenario (ADR-103, `firstSpeaker`, defaulting to
 * "caller" = inbound). With `firstSpeaker: "agent"` the agent's greeting is
 * turn one and the caller only reacts, which is what an outbound call
 * actually looks like — and outbound is 10 of the 11 calls ever placed in
 * production, so before ADR-103 the shape this product almost exclusively
 * runs was the one shape never tested here.
 *
 * Fidelity limit worth stating: the greeting exercised here is the
 * LLM-generated one, not stream.ts's `literalGreetingText` canned-line fast
 * path. That is currently the realistic choice rather than a shortcut —
 * production rejected the literal greeting on 11 of 11 calls (see the
 * unresolved-merge-tag diagnostic in stream.ts), so the LLM greeting is the
 * path every real call has actually taken. If that ratio ever inverts, this
 * comment is the thing that is now wrong.
 *
 * The greeting is an extra agent turn on top of `maxTurns`, which counts
 * caller/agent exchanges. If the greeting comes back empty the loop simply
 * proceeds with the caller opening, i.e. it degrades to inbound rather than
 * producing an empty transcript.
 */
export async function runSyntheticTest(
  agentConfig: ResolvedAgentConfig,
  scenario: SyntheticScenario,
  orgId?: string,
): Promise<SyntheticTestResult> {
  const transcript: SyntheticTurn[] = [];
  const toolCallsByAgent: string[] = [];
  let endedBy: SyntheticTestResult["endedBy"] = "max-turns";

  const callerModel = scenario.callerModel
    ? resolveVoiceModel(scenario.callerModel.provider, scenario.callerModel.model)
    : CALLER_MODEL;

  if ((scenario.firstSpeaker ?? "caller") === "agent") {
    const greeting = await runAgentTurn(agentConfig, transcript, orgId, true);
    toolCallsByAgent.push(...greeting.toolCalls);
    if (greeting.text) transcript.push({ role: "agent", text: greeting.text });
  }

  for (let turn = 0; turn < scenario.maxTurns; turn++) {
    const callerText = await runCallerTurn(scenario.callerPersonaPrompt, transcript, callerModel);
    if (!callerText) {
      endedBy = "caller-silent";
      console.warn(
        `[synthetic] scenario "${scenario.key}" — caller model returned an empty turn at turn ${turn} ` +
          `(transcript length ${transcript.length}); assertions below are scored against a short transcript`,
      );
      break;
    }
    transcript.push({ role: "caller", text: callerText });

    const agentTurn = await runAgentTurn(agentConfig, transcript, orgId);
    toolCallsByAgent.push(...agentTurn.toolCalls);
    if (agentTurn.text) transcript.push({ role: "agent", text: agentTurn.text });

    if (agentTurn.toolCalls.includes("hangUp")) {
      endedBy = "hangup";
      break;
    }
  }

  const assertions: SyntheticAssertionResult[] = scenario.assertions.map((assertion) => ({
    assertion,
    passed: checkAssertion(assertion, transcript, toolCallsByAgent),
  }));

  const callerOffScript = findCallerOffScript(scenario.callerMustSay, transcript);
  if (callerOffScript.length > 0) {
    endedBy = "caller-off-script";
    console.warn(
      `[synthetic] scenario "${scenario.key}" — the scripted caller never said ${JSON.stringify(callerOffScript)}; ` +
        "the agent was never put in the situation under test, so this run is invalid rather than passing",
    );
  }

  return {
    scenarioKey: scenario.key,
    transcript,
    toolCallsByAgent,
    endedBy,
    assertions,
    allPassed: callerOffScript.length === 0 && assertions.every((a) => a.passed),
    callerOffScript: callerOffScript.length > 0 ? callerOffScript : undefined,
  };
}
