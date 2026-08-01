import { describe, it, expect } from "bun:test";
import { AVAILABLE_TOOL_NAMES, TOOL_LABELS } from "./agent-config";
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
