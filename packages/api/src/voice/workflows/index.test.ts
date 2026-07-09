import { describe, it, expect } from "bun:test";
import { parseWorkflows, getWorkflowsForNumber } from "./index";
import type { WorkflowConfig } from "./types";

describe("parseWorkflows", () => {
  it("returns empty array for undefined input", () => {
    expect(parseWorkflows(undefined)).toEqual([]);
  });

  it("returns empty array for malformed JSON", () => {
    expect(parseWorkflows("{not valid")).toEqual([]);
  });

  it("returns empty array when the JSON is valid but not an array", () => {
    expect(parseWorkflows('{"name":"x"}')).toEqual([]);
  });

  it("parses a valid workflow array", () => {
    const raw = JSON.stringify([{ name: "lead-followup", onOutcome: { "no-answer": { action: "none" } } }]);
    const parsed = parseWorkflows(raw);
    expect(parsed.length).toBe(1);
    expect(parsed[0]?.name).toBe("lead-followup");
  });
});

describe("getWorkflowsForNumber", () => {
  const wildcard: WorkflowConfig = { name: "applies-to-all", onOutcome: {} };
  const scoped: WorkflowConfig = { name: "applies-to-one", numbers: ["+15551234567"], onOutcome: {} };
  const list = [wildcard, scoped];

  it("matches a wildcard workflow (no numbers field) for any number", () => {
    const result = getWorkflowsForNumber("+19998887777", list);
    expect(result.map((w) => w.name)).toEqual(["applies-to-all"]);
  });

  it("matches a scoped workflow only for its listed number", () => {
    const result = getWorkflowsForNumber("+15551234567", list);
    expect(result.map((w) => w.name).sort()).toEqual(["applies-to-all", "applies-to-one"]);
  });
});
