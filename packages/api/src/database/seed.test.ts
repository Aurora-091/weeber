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
        values: (data: { key: string; defaultPersonaPrompt: string }) => {
          inserted.push(data);
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

import { seedAgentTemplates } from "./seed";

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

    // All 5 templates (3 Shopify + 2 Insurance, as of the insurance-vertical
    // prep work) should have gone through insert (since existingKeys is
    // always empty in this mock) with real, non-empty prompt content read
    // off disk.
    expect(inserted.length).toBe(5);
    for (const row of inserted) {
      expect(row.defaultPersonaPrompt.length).toBeGreaterThan(0);
    }
  });
});
