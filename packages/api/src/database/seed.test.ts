import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Regression test for the seed.ts path bug (found during audit, 2026-07-10):
 * `promptsDir` was computed as `packages/docs/agent-prompts` (3 levels up
 * from packages/api/src/database) when the real files live at
 * `<repo-root>/docs/agent-prompts` (4 levels up). Every `Bun.file(...).exists()`
 * check silently returned false as a result, so `agentTemplates` stayed
 * completely empty in every environment (local and Railway alike) despite
 * the function unconditionally logging "seeded successfully" at the end.
 *
 * This test deliberately does NOT mock `Bun.file` — it hits the real
 * filesystem, exactly like production does, so a regression of the path
 * bug fails this test the same way it silently broke production.
 */

let inserted: Array<{ key: string; defaultPersonaPrompt: string }> = [];
let updated: Array<{ key: string; defaultPersonaPrompt: string }> = [];

mock.module("./index", () => {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            // Always "no existing row" — every template goes through the
            // insert branch below, which is all this test needs to assert
            // the path fix (D5) actually resolves real files.
            limit: () => [],
          }),
        }),
      }),
      insert: (_table: unknown) => ({
        values: (data: Record<string, unknown>) => {
          // A plain org-row shape (from the `weeber-pitch-agent`'s ownerOrgId-ensure step, see
          // 2026-08-27) has no `key` field — agentTemplates rows always do. Keep it out of
          // `inserted` so the template-seeding assertions below aren't polluted, and give it the
          // `onConflictDoNothing()` chain the real call makes.
          if (!("key" in data)) return { onConflictDoNothing: () => Promise.resolve() };
          inserted.push(data as { key: string; defaultPersonaPrompt: string });
          return Promise.resolve();
        },
      }),
      update: (_table: unknown) => ({
        set: (data: { defaultPersonaPrompt: string }) => ({
          where: () => {
            updated.push({ key: "unknown", defaultPersonaPrompt: data.defaultPersonaPrompt });
            return Promise.resolve();
          },
        }),
      }),
    },
  };
});

import { seedAgentTemplates, AGENT_TEMPLATES } from "./seed";
import { AVAILABLE_TOOL_NAMES } from "../voice/agent-frame";
import { join } from "node:path";
import { renderTemplate } from "../voice/workflows/variables";

/**
 * Regression guard (2026-07-16 audit follow-up) for the confirmCodOrder/
 * offerCartRecoveryDiscount bug: both were listed in a template's
 * `defaultTools` and referenced in that template's own script doc's "Tools"
 * table, but were never added to AVAILABLE_TOOL_NAMES or agent.ts's
 * buildVoiceTools map — so buildVoiceTools silently filtered them out of
 * every real call's tool list. The model was instructed by its own persona
 * to call a tool it was never actually given, with no error anywhere; the
 * only way this was caught was reading a live call's production log line by
 * line. This test makes the next tool addition fail CI instead of shipping
 * silently broken — if it ever fails, either add the new tool name to
 * AVAILABLE_TOOL_NAMES + buildVoiceTools's allTools map, or fix the typo in
 * the template's defaultTools list.
 */
describe("AGENT_TEMPLATES.defaultTools — registry consistency", () => {
  it("every template's defaultTools is a subset of AVAILABLE_TOOL_NAMES", () => {
    const known = new Set<string>(AVAILABLE_TOOL_NAMES);
    const unknownRefs: string[] = [];
    for (const template of AGENT_TEMPLATES) {
      for (const toolName of template.defaultTools) {
        if (!known.has(toolName)) {
          unknownRefs.push(
            `Template "${template.key}" lists defaultTools "${toolName}", which is not in ` +
              `AVAILABLE_TOOL_NAMES (agent-frame.ts) — the model would be told to use a tool it ` +
              `never actually has access to (see agent.ts's buildVoiceTools). Add "${toolName}" to ` +
              `AVAILABLE_TOOL_NAMES and to agent.ts's voiceTools/allTools map, or fix the typo here.`,
          );
        }
      }
    }
    expect(unknownRefs).toEqual([]);
  });
});

describe("seedAgentTemplates", () => {
  beforeEach(() => {
    inserted = [];
    updated = [];
  });

  it("resolves the real docs/agent-prompts directory and seeds all real templates (not skipped)", async () => {
    const consoleErrors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => consoleErrors.push(args);

    try {
      await seedAgentTemplates();
    } finally {
      console.error = originalError;
    }

    // The bug's exact symptom: every template hit "Prompt file does not
    // exist" and was skipped. Assert that did NOT happen for any template.
    const missingFileErrors = consoleErrors.filter((args) => String(args[0]).includes("Prompt file does not exist"));
    expect(missingFileErrors).toEqual([]);

    // All 10 templates (3 Shopify + 6 Insurance + 1 demo-widget) should have gone through
    // insert (since existingKeys is always empty in this mock) with real,
    // non-empty prompt content read off disk. Insurance set: 04/05 policy-
    // renewal + lead-followup, plus the appointment-setter, post-sale-welcome,
    // and feedback-nps agents (2026-07-16), plus the final-expense qualifier
    // (09, added 2026-07-19). The demo set: weeber-pitch-agent (2026-08-27).
    expect(inserted.length).toBe(10);
    for (const row of inserted) {
      expect(row.defaultPersonaPrompt.length).toBeGreaterThan(0);
    }

    // Stronger regression guard (2026-07-16, insurance India+US regulatory iteration): the
    // registry-consistency test above only checks that defaultTools is a *subset* of
    // AVAILABLE_TOOL_NAMES — it doesn't catch the actual confirmCodOrder/offerCartRecoveryDiscount
    // failure mode, which was a script's prompt text calling a tool that was silently missing from
    // that template's OWN defaultTools (found again manually this session: 04/05 started calling
    // flagGuardrailEvent in their guardrails text without it being added to defaultTools, until
    // fixed). Every backtick-wrapped tool name mentioned in a template's real prompt file must be
    // present in that same template's defaultTools — parse the actual seeded content, not a
    // hand-maintained list, so this can't drift out of sync with the prompt files again.
    const missingFromDefaultTools: string[] = [];
    const knownToolNames = new Set<string>(AVAILABLE_TOOL_NAMES);
    for (const row of inserted) {
      const template = AGENT_TEMPLATES.find((t) => t.key === row.key);
      if (!template) continue;
      // Scoped to the "## Tools — explicit mapping" section specifically (every prompt file has
      // one, confirmed by convention) — scanning the whole file catches prose that merely
      // *mentions* a tool name in passing (e.g. explaining a "known gap" about a different
      // system's tool of the same name), which is a real false positive this test hit once while
      // being written: 01-cart-recovery-agent.md's "known gap" paragraph about
      // workflows/engine.ts's SMS action mentions `sendSms` in prose, but that agent never
      // actually calls it — its real Tools table doesn't list it. Only the Tools table itself
      // reflects what the agent is actually instructed to call.
      // Bounded to the markdown table itself (lines starting with "|"), not any prose before/after
      // it — every prompt's "## Tools" section is often followed by a "Known gap" paragraph that
      // can legitimately mention an unrelated tool name in passing (found exactly this while
      // writing this test: 01-cart-recovery-agent.md's known-gap prose mentions `sendSms` as a
      // different system's action, not something this agent calls — only the table itself
      // reflects what the agent actually calls).
      // Read the tools table off the FILE, not off `row.defaultPersonaPrompt`.
      // ADR-104 moved the "## Tools — explicit mapping" table outside the
      // runtime markers, so the seeded prompt no longer contains it — leaving
      // this read pointed at the seeded value would have made the whole check
      // silently vacuous (empty section, zero tool names, always green), which
      // is the exact defect class ADR-090 is about. The table is still the
      // authoritative statement of what each agent is instructed to call, so
      // the guard follows it to the file.
      const fileText = await Bun.file(
        join(import.meta.dir, "../../../../docs/agent-prompts", template.fileName),
      ).text();
      const afterHeading = fileText.split("## Tools")[1] ?? "";
      expect(
        afterHeading.length,
        `${template.fileName} has no "## Tools" section — this guard reads it to check the template's ` +
          `defaultTools list, and would silently pass on an empty string.`,
      ).toBeGreaterThan(0);
      const toolsSection = afterHeading
        .split("\n")
        .filter((line) => line.trim().startsWith("|"))
        .join("\n");
      const toolNamesInPrompt = new Set(
        [...toolsSection.matchAll(/`([a-zA-Z]+)/g)]
          .map((m) => m[1])
          .filter((name): name is string => Boolean(name) && knownToolNames.has(name!)),
      );
      for (const toolName of toolNamesInPrompt) {
        if (!(template.defaultTools as readonly string[]).includes(toolName)) {
          missingFromDefaultTools.push(`Template "${template.key}" calls \`${toolName}\` in its Tools table but doesn't list it in defaultTools.`);
        }
      }
    }
    expect(missingFromDefaultTools).toEqual([]);
  });
});

/**
 * Fast-path resolution tests (2026-08-17, tags standardized 2026-08-20).
 *
 * Every seeded template's literalGreetingTemplate must resolve to a tag-free
 * string using ONLY the two guaranteed-resolvable values stream.ts always
 * provides: {{agent_name}} (defaults to "our team" when unconfigured) and
 * {{merchant_name}} (from orgs.name, when the org has one). If a template
 * still contained a lead-dependent tag (interest_area, lead_name,
 * policyholder_name, interaction_type) this test fails — which is exactly
 * what happened on 11/11 production calls before the 2026-08-17 fix.
 * {{company_name}} was an equivalent alias stream.ts also set (same value as
 * merchant_name) but is no longer used in any seeded template — one
 * canonical guaranteed tag, not two.
 *
 * The second test proves the fallback is safe: a template with an optional
 * extra tag that has NO value in context should leave that tag unresolved,
 * so stream.ts's guard correctly rejects it and falls back to the LLM path
 * (no crash, no empty string, the caller hears something either way).
 */
describe("literalGreetingTemplate — fast-path resolution", () => {
  // The minimum context stream.ts always provides. agent_name falls back to
  // "our team" when orgAgentConfigs.name is null; merchant_name is set from
  // orgs.name when the org has one (see stream.ts's greetingContext build).
  const GUARANTEED_CONTEXT = {
    agent_name: "Alex",
    merchant_name: "Acme Insurance",
  };

  it("every seeded template resolves to a tag-free string with only guaranteed context", () => {
    const UNRESOLVED_TAG = /\{\{\w+\}\}/;
    const failures: string[] = [];

    for (const t of AGENT_TEMPLATES) {
      if (!t.literalGreetingTemplate) continue;
      const rendered = renderTemplate(t.literalGreetingTemplate, GUARANTEED_CONTEXT);
      if (UNRESOLVED_TAG.test(rendered)) {
        const remaining = [...rendered.matchAll(/\{\{(\w+)\}\}/g)].map((m) => `{{${m[1]}}}`);
        failures.push(
          `Template "${t.key}" still has unresolved tags after guaranteed context: ${remaining.join(", ")}. ` +
            `These tags require a lead row that may not exist at call time — replace them with ` +
            `{{agent_name}} or {{merchant_name}}.`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  // Regression guard for the 2026-08-20 tag standardization: {{company_name}}
  // still resolves today (stream.ts sets it alongside merchant_name), so a
  // template using it would silently pass the test above — this catches a
  // template drifting back onto the non-canonical alias.
  it("no seeded template uses the {{company_name}} alias — {{merchant_name}} is the one canonical tag", () => {
    const templatesUsingAlias = AGENT_TEMPLATES.filter((t) => t.literalGreetingTemplate?.includes("{{company_name}}")).map(
      (t) => t.key,
    );
    expect(templatesUsingAlias).toEqual([]);
  });

  it("a template with an extra optional tag falls back safely when the tag has no value", () => {
    // Simulates a hypothetical template that still uses a lead-dependent tag.
    // renderTemplate leaves unresolved tags as-is (no crash, no empty string) —
    // stream.ts's unresolved-tag guard then detects it and falls back to the LLM.
    const templateWithOptionalTag =
      "Hi, is this {{lead_name}}? This is {{agent_name}} with {{merchant_name}}.";
    const rendered = renderTemplate(templateWithOptionalTag, GUARANTEED_CONTEXT);

    // The two guaranteed tags resolve; the optional one is left as-is.
    expect(rendered).toBe("Hi, is this {{lead_name}}? This is Alex with Acme Insurance.");

    // Confirm stream.ts's detection logic would reject this (the same regex it uses).
    const unresolvedTags = [...rendered.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
    expect(unresolvedTags).toEqual(["lead_name"]);
    // → stream.ts sees unresolvedGreetingTags.length > 0 and falls back to LLM. No crash.
  });

  it("the agent_name tag resolves even when the org has not configured a name", () => {
    // stream.ts: agent_name: agentConfig.agentName?.trim() || "our team"
    // No agentName configured → falls back to "our team".
    const template = "Hi, this is {{agent_name}} from {{merchant_name}}.";
    const rendered = renderTemplate(template, {
      agent_name: "our team",
      merchant_name: "Acme Co",
    });
    expect(rendered).toBe("Hi, this is our team from Acme Co.");
    expect(/\{\{\w+\}\}/.test(rendered)).toBe(false);
  });
});
