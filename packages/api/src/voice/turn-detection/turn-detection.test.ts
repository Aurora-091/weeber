import { describe, expect, test } from "bun:test";
import type { TurnEndDetector, TurnEndInput, TurnEndDecision } from "./types";
import { HeuristicTurnDetector, endsMidThought, HEURISTIC_DETECTOR_NAME } from "./heuristic";
import { withLatencyBudget } from "./budgeted";
import { createCompositeTurnDetector } from "./composite";
import {
  createTurnDetector,
  SEMANTIC_TURN_DETECTION_FLAG,
  DEFAULT_REFINER_BUDGET_MS,
} from "./index";

// A controllable model stand-in: a network round-trip the tests can make
// answer, stall past the budget, or throw — no real vendor.
class StubModelTurnDetector implements TurnEndDetector {
  readonly name = "stub-model";
  constructor(
    private readonly behavior:
      | { kind: "answer"; done: boolean; delayMs?: number }
      | { kind: "throw"; delayMs?: number },
  ) {}
  async decide(_input: TurnEndInput): Promise<TurnEndDecision> {
    const delay = this.behavior.delayMs ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (this.behavior.kind === "throw") throw new Error("model exploded");
    return this.behavior.done
      ? { done: true, by: this.name }
      : { done: false, by: this.name, reason: "mid-thought" };
  }
}

describe("heuristic adapter", () => {
  test("holds on trailing conjunction/filler (mid-thought)", async () => {
    const d = new HeuristicTurnDetector();
    for (const text of ["I want to order and", "so", "give me a refund because"]) {
      const r = await d.decide({ text });
      expect(r.done).toBe(false);
      expect(r.reason).toBe("mid-thought");
      expect(r.by).toBe(HEURISTIC_DETECTOR_NAME);
    }
  });

  test("answers on a complete-looking turn", async () => {
    const r = await new HeuristicTurnDetector().decide({ text: "I want to cancel my order" });
    expect(r.done).toBe(true);
    expect(r.by).toBe(HEURISTIC_DETECTOR_NAME);
  });

  test("wraps the same regex endsMidThought exposes", () => {
    expect(endsMidThought("hold on and")).toBe(true);
    expect(endsMidThought("that's all")).toBe(false);
  });
});

describe("withLatencyBudget", () => {
  const fallback = new HeuristicTurnDetector();

  test("uses primary when it answers within budget", async () => {
    const primary = new StubModelTurnDetector({ kind: "answer", done: false });
    const budgeted = withLatencyBudget(primary, fallback, 200);
    const r = await budgeted.decide({ text: "I want to cancel my order" });
    // primary said not-done even though the text looks complete → primary won.
    expect(r.done).toBe(false);
    expect(r.by).toBe("stub-model");
  });

  test("falls back to heuristic when primary exceeds the budget", async () => {
    const primary = new StubModelTurnDetector({ kind: "answer", done: false, delayMs: 100 });
    const budgeted = withLatencyBudget(primary, fallback, 10);
    // Text looks complete → heuristic fallback says done, proving primary was ignored.
    const r = await budgeted.decide({ text: "I want to cancel my order" });
    expect(r.done).toBe(true);
    expect(r.by).toBe(HEURISTIC_DETECTOR_NAME);
  });

  test("falls back to heuristic when primary throws", async () => {
    const primary = new StubModelTurnDetector({ kind: "throw" });
    const budgeted = withLatencyBudget(primary, fallback, 200);
    const r = await budgeted.decide({ text: "and" });
    // heuristic fallback catches the mid-thought.
    expect(r.done).toBe(false);
    expect(r.by).toBe(HEURISTIC_DETECTOR_NAME);
  });
});

describe("createCompositeTurnDetector", () => {
  const heuristic = new HeuristicTurnDetector();

  test("returns the plain heuristic when no refiner", () => {
    expect(createCompositeTurnDetector(heuristic, null)).toBe(heuristic);
  });

  test("short-circuits (skips refiner) when heuristic wants to hold", async () => {
    let refinerCalls = 0;
    const refiner: TurnEndDetector = {
      name: "counting",
      async decide() {
        refinerCalls += 1;
        return { done: true, by: "counting" };
      },
    };
    const composite = createCompositeTurnDetector(heuristic, refiner);
    const r = await composite.decide({ text: "I want to order and" });
    expect(r.done).toBe(false);
    expect(r.reason).toBe("mid-thought");
    expect(refinerCalls).toBe(0);
  });

  test("consults refiner only when the turn looks complete", async () => {
    const refiner = new StubModelTurnDetector({ kind: "answer", done: false });
    const composite = createCompositeTurnDetector(heuristic, refiner);
    const r = await composite.decide({ text: "I want to cancel my order" });
    // heuristic said done, refiner overrode to not-done.
    expect(r.done).toBe(false);
    expect(r.by).toBe("stub-model");
  });
});

describe("createTurnDetector factory", () => {
  test("flag off → plain heuristic (today's behavior)", () => {
    const d = createTurnDetector({ semanticEnabled: false, refiner: new StubModelTurnDetector({ kind: "answer", done: true }) });
    expect(d).toBeInstanceOf(HeuristicTurnDetector);
  });

  test("flag on but no refiner (Phase V default) → plain heuristic", () => {
    const d = createTurnDetector({ semanticEnabled: true, refiner: null });
    expect(d).toBeInstanceOf(HeuristicTurnDetector);
  });

  test("flag on + refiner → budgeted composite that can override", async () => {
    const refiner = new StubModelTurnDetector({ kind: "answer", done: false });
    const d = createTurnDetector({ semanticEnabled: true, refiner });
    expect(d).not.toBeInstanceOf(HeuristicTurnDetector);
    const r = await d.decide({ text: "I want to cancel my order" });
    expect(r.done).toBe(false);
    expect(r.by).toBe("stub-model");
  });

  test("a slow refiner degrades to the heuristic within budget", async () => {
    const refiner = new StubModelTurnDetector({ kind: "answer", done: false, delayMs: 50 });
    const d = createTurnDetector({ semanticEnabled: true, refiner, refinerBudgetMs: 5 });
    const r = await d.decide({ text: "I want to cancel my order" });
    expect(r.done).toBe(true);
    expect(r.by).toBe(HEURISTIC_DETECTOR_NAME);
  });

  test("exposed constants are stable", () => {
    expect(SEMANTIC_TURN_DETECTION_FLAG).toBe("semantic-turn-detection");
    expect(DEFAULT_REFINER_BUDGET_MS).toBe(300);
  });
});
