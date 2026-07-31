import type { TurnEndDetector, TurnEndDecision } from "./types";

/**
 * Wrap a (possibly slow / model-backed) detector so it can NEVER stall the
 * hottest line in the product. If `primary` doesn't answer within `budgetMs`,
 * or it throws, we fall back to `fallback`'s decision (the cheap heuristic).
 *
 * This is the single guarantee that makes an EOT model safe to run inline: a
 * slow or failing model degrades to today's silence-timeout + regex behavior,
 * it never adds unbounded latency to end-of-turn. A rejected `primary` is
 * swallowed to `null` so a post-timeout rejection can't surface as an
 * unhandled rejection.
 */
export function withLatencyBudget(
  primary: TurnEndDetector,
  fallback: TurnEndDetector,
  budgetMs: number,
): TurnEndDetector {
  return {
    name: `budgeted(${primary.name}->${fallback.name},${budgetMs}ms)`,
    async decide(input) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const primaryResult = primary.decide(input).catch(() => null);
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
      });
      const winner: TurnEndDecision | null = await Promise.race([primaryResult, timeout]);
      if (timer) clearTimeout(timer);
      // primary answered in time (and didn't throw) — use it; otherwise the
      // budget elapsed or primary failed, so fall back to the cheap detector.
      return winner ?? fallback.decide(input);
    },
  };
}
