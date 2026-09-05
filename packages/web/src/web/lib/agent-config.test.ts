import { describe, it, expect } from "bun:test";
import { AVAILABLE_TOOL_NAMES, TOOL_LABELS, toFormState, formToAgentFrame } from "./agent-config";
// Deliberate cross-package relative import: packages/web already depends on
// @weeber/api, but the api package only exports its Hono AppType from its
// "." entry, so there is no published path for this constants module. The
// file it reaches into (voice/agent-frame.ts) imports nothing but zod, so
// pulling it into a browser-side test drags in no server runtime.
import { AVAILABLE_TOOL_NAMES as BACKEND_TOOL_NAMES } from "../../../../api/src/voice/agent-frame";

/**
 * Regression guard for a bug that has now shipped twice (confirmCodOrder +
 * offerCartRecoveryDiscount on 2026-07-16, setIntent again after that): a
 * tool exists on the backend but is missing from the web list, so it can
 * never be checked in the agent form — and worse, the moment a merchant
 * saves ANY change through that form, the submitted toolsEnabled array
 * silently drops the missing tool for that org permanently, because
 * resolveAgentConfig prefers a saved org override over the template default.
 *
 * The failure is silent in both directions and invisible in the UI, which is
 * exactly why it needs a test rather than a comment.
 */
describe("agent tool list parity (web <-> api)", () => {
  it("matches the backend AVAILABLE_TOOL_NAMES exactly, including order", () => {
    expect([...AVAILABLE_TOOL_NAMES]).toEqual([...BACKEND_TOOL_NAMES]);
  });

  it("has no tool the backend does not know about", () => {
    const backend = new Set<string>(BACKEND_TOOL_NAMES);
    const unknown = AVAILABLE_TOOL_NAMES.filter((n) => !backend.has(n));
    expect(unknown).toEqual([]);
  });

  it("exposes every backend tool to the form", () => {
    const web = new Set<string>(AVAILABLE_TOOL_NAMES);
    const missing = BACKEND_TOOL_NAMES.filter((n) => !web.has(n));
    expect(missing).toEqual([]);
  });

  it("contains no duplicate tool names", () => {
    expect(new Set(AVAILABLE_TOOL_NAMES).size).toBe(AVAILABLE_TOOL_NAMES.length);
  });
});

describe("TOOL_LABELS", () => {
  it("gives every available tool a merchant-facing label", () => {
    const unlabelled = AVAILABLE_TOOL_NAMES.filter((n) => !TOOL_LABELS[n]?.trim());
    expect(unlabelled).toEqual([]);
  });

  it("labels no tool that is not available", () => {
    const available = new Set<string>(AVAILABLE_TOOL_NAMES);
    const stale = Object.keys(TOOL_LABELS).filter((n) => !available.has(n));
    expect(stale).toEqual([]);
  });

  it("uses plain-language labels, not raw camelCase identifiers", () => {
    for (const [name, label] of Object.entries(TOOL_LABELS)) {
      expect(label, `label for ${name} should not be the raw tool name`).not.toBe(name);
      expect(label, `label for ${name} should be human readable`).toMatch(/^[A-Z]/);
    }
  });
});

import {
  STRICTNESS_LEVELS,
  TOOL_EDITOR_META,
  TOOL_GROUPS,
  GUARDRAIL_TOPIC_LINES,
  GUARDRAIL_INJECTION_LINES,
  guardrailAbuseLine,
} from "./agent-config";
// Same deliberate cross-package relative import as above. prompt-lines.ts has
// exactly one import (a type-only one), so nothing server-side comes with it.
import {
  TOPIC_BOUNDARY_LINES,
  INJECTION_LINES,
  abuseHandlingLine,
} from "../../../../api/src/voice/prompt-lines";

/**
 * Phase III / D4 (ADR-067). The agent editor used to render the raw camelCase
 * tool identifier as the chip a merchant ticks — a permissions decision made
 * from a variable name. These guard the replacement metadata: a tool added to
 * the backend but never described here would regress straight back to that.
 */
describe("TOOL_EDITOR_META (agent editor chips)", () => {
  it("describes every tool the form can offer", () => {
    const missing = AVAILABLE_TOOL_NAMES.filter((n) => !TOOL_EDITOR_META[n]);
    expect(missing).toEqual([]);
  });

  it("describes no tool the form cannot offer", () => {
    const available = new Set<string>(AVAILABLE_TOOL_NAMES);
    const stale = Object.keys(TOOL_EDITOR_META).filter((n) => !available.has(n));
    expect(stale).toEqual([]);
  });

  it("never falls back to the raw identifier as the human label", () => {
    for (const [name, meta] of Object.entries(TOOL_EDITOR_META)) {
      expect(meta.label, `label for ${name}`).not.toBe(name);
      expect(meta.label.trim().length, `label for ${name}`).toBeGreaterThan(0);
      expect(meta.label, `label for ${name} should read as a sentence, not camelCase`).not.toMatch(/^[a-z]+[A-Z]/);
    }
  });

  it("gives every tool a non-empty one-line description", () => {
    for (const [name, meta] of Object.entries(TOOL_EDITOR_META)) {
      expect(meta.description.trim().length, `description for ${name}`).toBeGreaterThan(0);
      expect(meta.description, `description for ${name} should be one line`).not.toContain("\n");
    }
  });

  it("assigns every tool to a real consequence group", () => {
    const groups = new Set<string>(TOOL_GROUPS.map((g) => g.key));
    for (const [name, meta] of Object.entries(TOOL_EDITOR_META)) {
      expect(groups.has(meta.group), `group for ${name} (${meta.group})`).toBe(true);
    }
  });

  it("leaves no group empty — an empty heading renders as a dead section", () => {
    for (const group of TOOL_GROUPS) {
      const members = Object.values(TOOL_EDITOR_META).filter((m) => m.group === group.key);
      expect(members.length, `group ${group.key}`).toBeGreaterThan(0);
    }
  });

  it("keeps the irreversible tools out of the low-stakes groups", () => {
    // These act on the real world and outlive the call — miscategorising one
    // as "data capture" would understate what the merchant is granting.
    for (const name of ["sendSms", "bookAppointment", "confirmCodOrder", "offerCartRecoveryDiscount"] as const) {
      expect(TOOL_EDITOR_META[name].group, name).toBe("side-effects");
    }
  });
});

/**
 * Phase III / D3 (ADR-067). The guardrail dials now render the exact sentence
 * they inject into the system prompt. That is only honest while these strings
 * match the backend's; if they drift, the editor is showing a merchant text
 * their agent is never given.
 */
describe("guardrail consequence copy parity (web <-> api)", () => {
  it("matches the backend's stay-on-topic sentences exactly", () => {
    for (const level of ["low", "medium", "high"] as const) {
      expect(GUARDRAIL_TOPIC_LINES[level]).toBe(TOPIC_BOUNDARY_LINES[level]);
    }
  });

  it("matches the backend's manipulation-sensitivity sentences exactly", () => {
    for (const level of ["low", "medium", "high"] as const) {
      expect(GUARDRAIL_INJECTION_LINES[level]).toBe(INJECTION_LINES[level]);
    }
  });

  it("matches the backend's abuse-handling sentence in all four states", () => {
    for (const enabled of [true, false]) {
      for (const canFlag of [true, false]) {
        expect(guardrailAbuseLine(enabled, canFlag)).toBe(abuseHandlingLine(enabled, canFlag));
      }
    }
  });

  it("covers every strictness level the form can select", () => {
    for (const level of STRICTNESS_LEVELS) {
      expect(GUARDRAIL_TOPIC_LINES[level], `topic line for ${level}`).toBeTruthy();
      expect(GUARDRAIL_INJECTION_LINES[level], `injection line for ${level}`).toBeTruthy();
    }
  });
});

/**
 * Voice-pipeline hardening plan, Stage 5 (2026-09-05) — the exact bug class
 * org-queries.test.ts guards on the backend (sttFallbackOrder/
 * ttsFallbackOrder/llmFallbackModels shipped in the schema without ever
 * reaching the write path) has a frontend-side twin: a field present in
 * `AgentConfigRow` that `formToAgentFrame` never actually reads back out of
 * `FormState` would silently never save either, no backend bug required.
 */
describe("voiceIdsByProvider form round-trip (Stage 5)", () => {
  function rowWith(voiceIdsByProvider: Record<string, string> | null) {
    return {
      templateKey: "template-a",
      templateName: "Template A",
      templateDescription: null,
      defaultPersonaPrompt: null,
      config: {
        name: null,
        greetingLine: null,
        closingLine: null,
        toneStyle: null,
        personaPrompt: null,
        voiceProvider: "cartesia",
        voiceId: "cartesia-id",
        voiceIdsByProvider,
        language: null,
        sttProvider: null,
        llmProvider: null,
        llmModel: null,
        sttFallbackOrder: null,
        ttsFallbackOrder: null,
        llmFallbackModels: null,
        toolsEnabled: null,
        guardrails: null,
        enabled: true,
        firstCallDelayMinutes: null,
        retryDelayMinutes: null,
        maxAttempts: null,
        phoneNumberId: null,
        humanTransferNumber: null,
      },
    };
  }

  it("loads a saved map into the form, one field per provider", () => {
    const form = toFormState(rowWith({ cartesia: "cartesia-id", elevenlabs: "el-id" }));
    expect(form.voiceIdsByProvider).toEqual({ elevenlabs: "el-id", cartesia: "cartesia-id", sarvam: "" });
  });

  it("sends only the providers with a non-empty value, as a plain object", () => {
    const form = toFormState(rowWith(null));
    form.voiceIdsByProvider.cartesia = "cartesia-id";
    form.voiceIdsByProvider.sarvam = "  "; // whitespace-only counts as unset
    expect(formToAgentFrame(form).voiceIdsByProvider).toEqual({ cartesia: "cartesia-id" });
  });

  it("sends undefined, not an empty object, when no provider has a value", () => {
    const form = toFormState(rowWith(null));
    expect(formToAgentFrame(form).voiceIdsByProvider).toBeUndefined();
  });
});
