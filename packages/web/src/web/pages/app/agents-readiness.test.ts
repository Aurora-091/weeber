import { describe, expect, it } from "bun:test";
import { agentReadiness, agentUsesTransferToHuman, classifyReadiness, resolveAgentTransferNumber } from "./agents";
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
 * at all before the grid existed — and an agent that dials fine but has had a
 * capability silently removed under it (ADR-105) is the one they could not see
 * even after.
 */

const FULL_CAPS = { transferToHumanEnabled: true, hasHumanTransferNumber: true };

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
    const r = classifyReadiness(false, false, FULL_CAPS);
    expect(r.state).toBe("paused");
    expect(r.label).toBe("Paused");
    expect(r.detail).toBeNull();
  });

  it("enabled with no caller ID is 'needs-number', not 'live'", () => {
    const r = classifyReadiness(true, false, FULL_CAPS);
    expect(r.state).toBe("needs-number");
    expect(r.label).toBe("Needs a number");
  });

  it("enabled with a caller ID and nothing narrowed is fully live", () => {
    const r = classifyReadiness(true, true, FULL_CAPS);
    expect(r.state).toBe("live");
    expect(r.detail).toBeNull();
  });

  it("uses semantic status tokens only — never raw Tailwind colour utilities", () => {
    // UI-DESIGN-BRIEF: product surfaces use the .theme-weeber semantic set.
    // A raw `amber-*`/`emerald-*` value here is what made the detail-page
    // banner unreadable in light mode (fixed 2026-08-01) — don't reintroduce it.
    const all = [
      classifyReadiness(true, true, FULL_CAPS),
      classifyReadiness(true, false, FULL_CAPS),
      classifyReadiness(false, true, FULL_CAPS),
      classifyReadiness(true, true, { transferToHumanEnabled: true, hasHumanTransferNumber: false }),
    ];
    for (const r of all) {
      const cls = `${r.pillCls} ${r.dotCls}`;
      expect(cls).not.toMatch(/\b(amber|emerald|zinc|red|green|yellow)-\d{2,3}\b/);
    }
  });

  // -------------------------------------------------------------------------
  // "degraded" — dials, connects, and then can't finish the job (ADR-105).
  // -------------------------------------------------------------------------
  it("an agent that will transfer, on an org with no transfer number, is degraded — not live", () => {
    const r = classifyReadiness(true, true, { transferToHumanEnabled: true, hasHumanTransferNumber: false });
    expect(r.state).toBe("degraded");
    expect(r.label).not.toBe("Live");
    // The label has to admit the limit on its own, because the grid pill is all
    // some merchants ever read.
    expect(r.label.toLowerCase()).toContain("limited");
  });

  it("names the actual gap in `detail`, so the card and the banner can't describe it differently", () => {
    const r = classifyReadiness(true, true, { transferToHumanEnabled: true, hasHumanTransferNumber: false });
    expect(r.detail).toBeTruthy();
    expect(r.detail!.toLowerCase()).toContain("transfer");
  });

  it("is NOT degraded when the agent never transfers — a missing transfer number costs it nothing", () => {
    const r = classifyReadiness(true, true, { transferToHumanEnabled: false, hasHumanTransferNumber: false });
    expect(r.state).toBe("live");
  });

  it("a missing caller ID outranks a narrowed capability — report the gap that bites first", () => {
    const r = classifyReadiness(true, false, { transferToHumanEnabled: true, hasHumanTransferNumber: false });
    expect(r.state).toBe("needs-number");
  });

  it("a paused agent is never reported as degraded", () => {
    const r = classifyReadiness(false, true, { transferToHumanEnabled: true, hasHumanTransferNumber: false });
    expect(r.state).toBe("paused");
  });

  it("only 'live' carries the success tokens — degraded must not read as green", () => {
    const degraded = classifyReadiness(true, true, { transferToHumanEnabled: true, hasHumanTransferNumber: false });
    expect(degraded.pillCls).not.toContain("success");
    expect(degraded.dotCls).not.toContain("success");
    expect(classifyReadiness(true, true, FULL_CAPS).pillCls).toContain("success");
  });
});

describe("agentUsesTransferToHuman", () => {
  it("a never-saved agent runs the full tool set, so it does transfer", () => {
    // This is the production shape: config is null until the merchant saves
    // once, and the default tool list includes transferToHuman. Getting this
    // backwards would hide the gap on exactly the orgs that have it.
    expect(agentUsesTransferToHuman(row(null))).toBe(true);
  });

  it("respects an explicit tool list that omits it", () => {
    expect(agentUsesTransferToHuman(row({ toolsEnabled: ["lookupInfo", "hangUp"] }))).toBe(false);
    expect(agentUsesTransferToHuman(row({ toolsEnabled: ["lookupInfo", "transferToHuman"] }))).toBe(true);
  });

  it("an empty saved tool list means no tools, not 'all tools'", () => {
    expect(agentUsesTransferToHuman(row({ toolsEnabled: [] }))).toBe(false);
  });
});

/**
 * ADR-114. The web mirror of the backend's `resolveTransferTarget` — same
 * precedence, same blank-is-absent rule. If these two ever disagree, the UI
 * tells a merchant one thing and the dialler does another.
 */
describe("resolveAgentTransferNumber", () => {
  const ORG = "+18005550199";

  it("prefers the agent's own number over the org's", () => {
    expect(resolveAgentTransferNumber("+18005550111", ORG)).toBe("+18005550111");
  });

  it("inherits the org number when the agent has none", () => {
    expect(resolveAgentTransferNumber(null, ORG)).toBe(ORG);
    expect(resolveAgentTransferNumber(undefined, ORG)).toBe(ORG);
  });

  it("treats a blank agent value as inherit, not as an override", () => {
    expect(resolveAgentTransferNumber("", ORG)).toBe(ORG);
    expect(resolveAgentTransferNumber("   ", ORG)).toBe(ORG);
  });

  it("returns null when neither level has one", () => {
    expect(resolveAgentTransferNumber(null, null)).toBeNull();
    expect(resolveAgentTransferNumber("  ", "")).toBeNull();
  });
});

describe("agentReadiness", () => {
  // ADR-114 changed the third argument from "does the ORG have a transfer
  // number" (boolean) to the org's number itself, because the agent's own
  // override has to be resolved per row.
  const ORG_TRANSFER = "+18005550199";

  it("treats a never-saved agent (config null) as enabled, matching toFormState's default", () => {
    expect(agentReadiness(row(null), true, ORG_TRANSFER).state).toBe("live");
  });

  it("an agent's own number satisfies the caller ID even with no org fallback", () => {
    expect(agentReadiness(row({ phoneNumberId: 7 }), false, ORG_TRANSFER).state).toBe("live");
  });

  it("falls back to the org outbound number when the agent has none of its own", () => {
    expect(agentReadiness(row({ phoneNumberId: null }), true, ORG_TRANSFER).state).toBe("live");
    expect(agentReadiness(row({ phoneNumberId: null }), false, ORG_TRANSFER).state).toBe("needs-number");
  });

  it("respects an explicit disable even when fully numbered", () => {
    expect(agentReadiness(row({ enabled: false, phoneNumberId: 7 }), true, ORG_TRANSFER).state).toBe("paused");
  });

  it("the fresh-org shape — numbered, never saved, no transfer number — is degraded", () => {
    // Every production org had human_transfer_number NULL as of 2026-08-12 and
    // the DB is now wiped, so this is the state the first real signup lands in.
    expect(agentReadiness(row(null), true, null).state).toBe("degraded");
  });

  it("an agent with transfer switched off is live on that same org", () => {
    expect(agentReadiness(row({ toolsEnabled: ["lookupInfo"] }), true, null).state).toBe("live");
  });

  // ADR-114's headline case, and the regression the per-agent column exists to
  // prevent: this agent CAN transfer, so warning the merchant to go and fix
  // org Settings would be false.
  it("an agent with its own transfer number is fully live on an org that has none", () => {
    expect(agentReadiness(row({ humanTransferNumber: "+18005550111" }), true, null).state).toBe("live");
  });

  it("a blank per-agent number does not shadow the org's — it inherits", () => {
    expect(agentReadiness(row({ humanTransferNumber: "" }), true, ORG_TRANSFER).state).toBe("live");
    expect(agentReadiness(row({ humanTransferNumber: "  " }), true, null).state).toBe("degraded");
  });
});
