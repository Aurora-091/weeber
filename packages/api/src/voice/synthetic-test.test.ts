import { describe, expect, test } from "bun:test";
import { checkAssertion, type SyntheticTurn } from "./synthetic-test";

const transcript: SyntheticTurn[] = [
  { role: "caller", text: "I'm calling about order ORD-48213" },
  { role: "agent", text: "I can help with that — let me look into it right away." },
  { role: "caller", text: "Great, thanks." },
  { role: "agent", text: "Your callback number is 98765 43210, is that correct?" },
];
const toolCallsByAgent = ["captureField", "hangUp"];

describe("synthetic-test assertions", () => {
  test("toolCalled passes when the tool appears anywhere in the call", () => {
    expect(checkAssertion({ type: "toolCalled", tool: "captureField", description: "" }, transcript, toolCallsByAgent)).toBe(true);
  });

  test("toolCalled fails when the tool never fires", () => {
    expect(checkAssertion({ type: "toolCalled", tool: "transferToHuman", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("toolNeverCalled passes when the tool never fires", () => {
    expect(checkAssertion({ type: "toolNeverCalled", tool: "transferToHuman", description: "" }, transcript, toolCallsByAgent)).toBe(true);
  });

  test("toolNeverCalled fails when the tool does fire", () => {
    expect(checkAssertion({ type: "toolNeverCalled", tool: "hangUp", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("agentSaid is case-insensitive and only checks agent turns", () => {
    expect(checkAssertion({ type: "agentSaid", text: "HELP", description: "" }, transcript, toolCallsByAgent)).toBe(true);
    expect(checkAssertion({ type: "agentSaid", text: "order ord-48213", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("agentNeverSaid fails when the agent did say it", () => {
    expect(checkAssertion({ type: "agentNeverSaid", text: "correct", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("agentNeverSaid passes when the agent never said it", () => {
    expect(checkAssertion({ type: "agentNeverSaid", text: "guarantee", description: "" }, transcript, toolCallsByAgent)).toBe(true);
  });
});
