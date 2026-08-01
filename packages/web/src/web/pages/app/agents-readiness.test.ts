import { describe, expect, it } from "bun:test";
import { agentReadiness, classifyReadiness } from "./agents";
import type { AgentConfigRow } from "../../lib/agent-config";

/**
 * The agents overview grid (2026-08-01) and the agent detail banner both claim
 * to tell a merchant whether an agent will actually place a call. They render
 * that verdict completely differently — a pill in a card vs. a full banner —
 * so the shared classifier is the only thing keeping them honest with each
 * other. These lock the rule, not the markup.
 *
 * The rule that matters: "enabled" in the DB is not "working". An agent with
 * its toggle on and no caller ID is the failure mode a merchant could not see
 * at all before the grid existed.
 */

function row(config: Partial<NonNullable<AgentConfigRow["config"]>> | null): AgentConfigRow {
  return {
    templateKey: "shopify-cart-recovery",
    templateName: "Cart recovery",
    templateDescription: "Calls customers who left a cart behind.",
    defaultPersonaPrompt: "You recover abandoned carts.",
    config: config === null ? null : ({ enabled: true, phoneNumberId: null, ...config } as NonNullable<AgentConfigRow["config"]>),
  };
}

describe("classifyReadiness", () => {
  it("paused wins over a missing number — a paused agent is not 'broken', it's off", () => {
    const r = classifyReadiness(false, false);
    expect(r.state).toBe("paused");
    expect(r.label).toBe("Paused");
  });

  it("enabled with no caller ID is 'needs-number', not 'live'", () => {
    const r = classifyReadiness(true, false);
    expect(r.state).toBe("needs-number");
    expect(r.label).toBe("Needs a number");
  });

  it("enabled with a caller ID is live", () => {
    expect(classifyReadiness(true, true).state).toBe("live");
  });

  it("uses semantic status tokens only — never raw Tailwind colour utilities", () => {
    // UI-DESIGN-BRIEF: product surfaces use the .theme-weeber semantic set.
    // A raw `amber-*`/`emerald-*` value here is what made the detail-page
    // banner unreadable in light mode (fixed 2026-08-01) — don't reintroduce it.
    for (const r of [classifyReadiness(true, true), classifyReadiness(true, false), classifyReadiness(false, true)]) {
      const cls = `${r.pillCls} ${r.dotCls}`;
      expect(cls).not.toMatch(/\b(amber|emerald|zinc|red|green|yellow)-\d{2,3}\b/);
    }
  });
});

describe("agentReadiness", () => {
  it("treats a never-saved agent (config null) as enabled, matching toFormState's default", () => {
    expect(agentReadiness(row(null), true).state).toBe("live");
  });

  it("an agent's own number satisfies the caller ID even with no org fallback", () => {
    expect(agentReadiness(row({ phoneNumberId: 7 }), false).state).toBe("live");
  });

  it("falls back to the org outbound number when the agent has none of its own", () => {
    expect(agentReadiness(row({ phoneNumberId: null }), true).state).toBe("live");
    expect(agentReadiness(row({ phoneNumberId: null }), false).state).toBe("needs-number");
  });

  it("respects an explicit disable even when fully numbered", () => {
    expect(agentReadiness(row({ enabled: false, phoneNumberId: 7 }), true).state).toBe("paused");
  });
});
