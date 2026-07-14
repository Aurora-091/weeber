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
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { resolveVoiceModel } from "./llm";
import { buildVoiceTools, buildKnownFactsBlock, type ResolvedAgentConfig } from "./agent";
import type { SyntheticScenario, SyntheticAssertion } from "./synthetic-scenarios";

export type SyntheticTurn = { role: "caller" | "agent"; text: string };
export type SyntheticAssertionResult = { assertion: SyntheticAssertion; passed: boolean };

export type SyntheticTestResult = {
  scenarioKey: string;
  transcript: SyntheticTurn[];
  toolCallsByAgent: string[];
  endedBy: "hangup" | "max-turns";
  assertions: SyntheticAssertionResult[];
  allPassed: boolean;
};

const CALLER_MODEL = resolveVoiceModel("gateway", "openai/gpt-5.4-mini");

/** One caller-LLM turn — no tools, just plays the scripted persona given the
 * transcript so far (from the caller's point of view: agent turns are
 * "assistant" to the caller model, caller's own prior turns are "user"). */
async function runCallerTurn(callerPersonaPrompt: string, transcriptSoFar: SyntheticTurn[]): Promise<string> {
  const messages: ModelMessage[] = transcriptSoFar.map((t) => ({
    role: t.role === "caller" ? "assistant" : "user",
    content: t.text,
  }));
  const result = streamText({
    model: CALLER_MODEL,
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
): Promise<{ text: string; toolCalls: string[] }> {
  const model = resolveVoiceModel(agentConfig.llmProvider, agentConfig.llmModel);
  // A3b: same knowledge-base binding a live call gets — a scenario that
  // exercises lookupInfo tests against this org's real KB, not a stub.
  const tools = buildVoiceTools(orgId, agentConfig.enabledTools);
  const messages: ModelMessage[] = transcriptSoFar.map((t) => ({
    role: t.role === "agent" ? "assistant" : "user",
    content: t.text,
  }));

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
    case "agentSaid":
      return agentText.includes(assertion.text.toLowerCase());
    case "agentNeverSaid":
      return !agentText.includes(assertion.text.toLowerCase());
  }
}

/**
 * Runs one scenario to completion (hangUp tool call, or maxTurns reached)
 * and scores it against the scenario's assertions. Caller speaks first,
 * same as a real inbound call.
 */
export async function runSyntheticTest(
  agentConfig: ResolvedAgentConfig,
  scenario: SyntheticScenario,
  orgId?: string,
): Promise<SyntheticTestResult> {
  const transcript: SyntheticTurn[] = [];
  const toolCallsByAgent: string[] = [];
  let endedBy: "hangup" | "max-turns" = "max-turns";

  for (let turn = 0; turn < scenario.maxTurns; turn++) {
    const callerText = await runCallerTurn(scenario.callerPersonaPrompt, transcript);
    if (!callerText) break;
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

  return {
    scenarioKey: scenario.key,
    transcript,
    toolCallsByAgent,
    endedBy,
    assertions,
    allPassed: assertions.every((a) => a.passed),
  };
}
