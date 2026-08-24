import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { AGENT_TEMPLATES } from "./seed";
import { extractRuntimePersona, findRuntimeLeaks } from "../voice/persona-source";

/**
 * Prompt hygiene guard (G1.3 + G1.4, 2026-08-01).
 *
 * `database/seed.ts` loads each of these markdown files *verbatim* into
 * `agentTemplates.defaultPersonaPrompt`. Every byte becomes system-prompt text
 * sent on every turn of every call. That makes these files production code with
 * a `.md` extension, and they had drifted into doubling as engineering docs.
 *
 * Two failure modes this file locks down, both of which shipped for real:
 *
 *  1. **Unrendered merge tags.** The persona body was never passed through
 *     `renderTemplate` — only `literalGreetingTemplate` was — so a
 *     `{{merchant_name}}` in the prompt was a string the agent could read out
 *     loud to a customer. `voice/merge-tags.ts` scrubs these at runtime as a
 *     last line of defense; this test is the first line, so an author finds out
 *     at CI rather than from a call recording.
 *  2. **Engineering metadata.** DB column names, source-file paths, dated
 *     internal notes, and competitor references were sitting in the prompt.
 *     They cost tokens, dilute the instructions that matter, and go stale —
 *     one such note was telling the live agent that a capability it actually
 *     has does not exist. Engineering context belongs in
 *     `docs/agent-prompts/notes/`, which the seeder never reads.
 */

const promptsDir = join(import.meta.dir, "../../../../docs/agent-prompts");

/**
 * Prompts not yet migrated off merge tags. The runtime scrub keeps these safe,
 * so this is a quality backlog, not an open vulnerability.
 *
 * **This list may only shrink.** Removing the last entry should delete the
 * allowlist along with it.
 */
const MERGE_TAG_MIGRATION_BACKLOG = new Set([
  "04-insurance-policy-renewal-agent.md",
  "05-insurance-lead-followup-agent.md",
  "06-insurance-appointment-setter-agent.md",
  "07-insurance-post-sale-welcome-agent.md",
  "08-insurance-feedback-nps-agent.md",
  // A5 (phase-a-integrity.md, 2026-08-24): repointed from
  // "09-insurance-final-expense-qualifier-agent.md" to the v2 file that
  // superseded it as the seeded source (seed.ts) — same un-migrated merge
  // tags, new filename.
  "09-insurance-final-expense-qualifier-agent-v2.md",
]);

/**
 * Substrings that have no business being spoken-agent instruction. Each one is
 * something that was actually found in a seeded prompt, not a hypothetical.
 */
const ENGINEERING_METADATA_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "a source-file path", pattern: /packages\/(api|web)\/src\// },
  { label: "a `.ts` source filename", pattern: /\b[\w-]+\.ts\b/ },
  { label: "a database table/column reference", pattern: /\b(scheduledCalls|orgAgentConfigs|agentTemplates|orgs)\.\w+/ },
  { label: "a competitor name", pattern: /\b(Bolna|Vapi|Retell|Bland)\b/i },
  { label: "the platform's own name (never said to an end customer)", pattern: /\bWeeber\b/ },
  { label: "a dated internal note", pattern: /\(\s*(flagged|added|updated)?\s*\d{4}-\d{2}-\d{2}\s*[,)]/ },
  { label: "a planning-doc reference", pattern: /WEEBER-PLAN|Phase [A-Z]\b|docs\/decisions|ADR-\d+/ },
];

async function readPrompt(fileName: string): Promise<string> {
  const file = Bun.file(join(promptsDir, fileName));
  expect(await file.exists()).toBe(true);
  return file.text();
}

/**
 * The seeded persona, not the authoring document (ADR-104).
 *
 * This file's two hygiene rules below were written when `seed.ts` loaded each
 * markdown file *verbatim*, so "the file" and "the prompt" were the same bytes
 * and scanning the file was the only way to scan the prompt. They are no longer
 * the same bytes: the seeder now extracts only the `runtime:begin`/`runtime:end`
 * region, and everything outside it — the `**File:**` header, the regulatory
 * grounding pointer, the tools mapping table, the authoring note — is
 * maintainer-facing and never reaches the model.
 *
 * So these rules are re-pointed at the extracted region rather than the file.
 * That is a tightening, not a relaxation: G1.4 below now runs against all nine
 * templates instead of only the three Shopify ones, because with the editorial
 * prose out of scope the insurance six pass it too. Scanning the whole file
 * would now fail on the authoring notes themselves, which is a false positive —
 * an ADR reference in a maintainer note is not something an agent can say.
 *
 * `extractRuntimePersona` throws when a file has no markers, so a new prompt
 * file that forgets them fails here as well as at seed time.
 */
async function readRuntimePersona(fileName: string): Promise<string> {
  return extractRuntimePersona(await readPrompt(fileName), fileName).runtime;
}

describe("seeded agent prompts — merge-tag hygiene (G1.3)", () => {
  for (const template of AGENT_TEMPLATES) {
    const migrated = !MERGE_TAG_MIGRATION_BACKLOG.has(template.fileName);
    it(`${template.fileName} ${migrated ? "contains no merge tags" : "(backlog) is tracked, not forgotten"}`, async () => {
      const content = await readRuntimePersona(template.fileName);
      const tags = [...new Set([...content.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))];
      if (migrated) {
        expect(
          tags,
          `${template.fileName} is a seeded persona and nothing renders its body — ` +
            `these tags would be read out loud to a customer. Supply the value through a facts block ` +
            `(buildWorkflowContextBlock / buildIdentityBlock) and write the instruction tag-free.`,
        ).toEqual([]);
      } else {
        // A backlog entry that has since been cleaned should be removed from
        // MERGE_TAG_MIGRATION_BACKLOG so it becomes a real guard.
        expect(
          tags.length,
          `${template.fileName} no longer has merge tags — remove it from MERGE_TAG_MIGRATION_BACKLOG.`,
        ).toBeGreaterThan(0);
      }
    });
  }

  it("the migration backlog only ever shrinks", () => {
    // Guards the guard: a new prompt file must not be added to the backlog to
    // dodge the rule above.
    expect(MERGE_TAG_MIGRATION_BACKLOG.size).toBeLessThanOrEqual(6);
  });
});

describe("seeded agent prompts — no engineering metadata (G1.4)", () => {
  // ADR-104: was scoped to the three Shopify templates, because the insurance
  // six carried their editorial header inside the seeded bytes and could not
  // pass. With the runtime/authoring split that prose is out of the prompt, so
  // this now runs against all nine.
  const allFileNames = AGENT_TEMPLATES.map((t) => t.fileName);

  for (const fileName of allFileNames) {
    it(`${fileName} reads as agent instruction, not as documentation`, async () => {
      const content = await readRuntimePersona(fileName);
      const offences: string[] = [];
      for (const { label, pattern } of ENGINEERING_METADATA_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          offences.push(`${label} — found ${JSON.stringify(match[0])}`);
        }
      }
      expect(
        offences,
        `${fileName}'s runtime region becomes system-prompt text on every turn. Move engineering ` +
          `context outside the runtime markers, or to docs/agent-prompts/notes/, which the seeder ` +
          `never reads.`,
      ).toEqual([]);
    });
  }
});

describe("docs/agent-prompts/notes/ — never seeded", () => {
  it("no template points at a file inside notes/", () => {
    // The whole split depends on this: notes/ is where the un-spoken context
    // lives, so nothing there may ever be loaded as a persona.
    for (const template of AGENT_TEMPLATES) {
      expect(template.fileName).not.toContain("/");
      expect(template.fileName).not.toContain("notes");
    }
  });
});

/**
 * The prompts tell the model how to call each tool, by example. Those examples are the model's
 * only specification of a tool's parameter names, and nothing previously checked them against the
 * tools' actual Zod schemas — so all nine prompts instructed
 * `captureField({ key, value })` while the tool has always declared `{ field, value }`.
 *
 * That is not a documentation typo. An argument object failing schema validation means the call
 * does not execute, which matches production: zero rows in `tool_calls`, on every call ever
 * placed, while `captureField` is the most-instructed tool in the set.
 *
 * This guard reads the parameter names out of the prompt examples and asserts each one exists on
 * the real tool, so the next drift fails at CI instead of silently disabling state capture.
 */
describe("seeded agent prompts — tool-call examples match the tools' real schemas", () => {
  /**
   * Parameter names each tool actually accepts, read off the `inputSchema` declarations in
   * `voice/tools/`. Only tools whose prompt examples pass a named object are listed; tools the
   * prompts only ever mention by name need no entry.
   */
  const TOOL_PARAMETERS: Record<string, string[]> = {
    captureField: ["field", "value"],
    flagGuardrailEvent: ["category", "detail"],
    setDisposition: ["disposition", "notes"],
    setIntent: ["intent", "notes"],
    transferToHuman: ["reason"],
    bookAppointment: ["callerName", "dateTimeIso", "notes"],
    crmSync: ["notes"],
    sendSms: ["body"],
  };

  for (const template of AGENT_TEMPLATES) {
    it(`${template.fileName} names only real tool parameters`, async () => {
      const content = await readPrompt(template.fileName);
      const offences: string[] = [];

      for (const [toolName, allowed] of Object.entries(TOOL_PARAMETERS)) {
        // Matches `toolName({ ... })` across the prompt, including the tools table rows.
        const callPattern = new RegExp(`${toolName}\\(\\{([^}]*)\\}`, "g");
        for (const call of content.matchAll(callPattern)) {
          const body = call[1] ?? "";
          // Property keys only: `foo:` at the start of the object or after a comma.
          for (const prop of body.matchAll(/(?:^|,)\s*([A-Za-z_]\w*)\s*:/g)) {
            const name = prop[1]!;
            if (!allowed.includes(name)) {
              offences.push(
                `${toolName} has no "${name}" parameter (accepts: ${allowed.join(", ")}) — ` +
                  `found in ${JSON.stringify(call[0])}`,
              );
            }
          }
        }
      }

      expect(
        offences,
        `${template.fileName} instructs the model to pass a parameter the tool does not declare. ` +
          `The call will fail schema validation at runtime and the tool will never execute.`,
      ).toEqual([]);
    });
  }
});

/**
 * The runtime/authoring contract itself (ADR-104).
 *
 * Root cause this locks down, measured from real production calls: because the
 * whole markdown document was seeded as the persona, 13-40% of every system
 * prompt was prose addressed to a maintainer, and the launch agent's persona was
 * 19,480 characters of which 40% was metadata. Production call 22 spoke
 * "Hello, is this ? This is calling on behalf of krisn" and call 24 spoke
 * "Hi, is this [Caller Name]? This is [Agent Name] with presistentads" — the
 * second of those is a bracket-grammar slot read aloud verbatim, because the
 * merge layer only resolves double-brace tags and left the brackets standing.
 *
 * Three properties are asserted here, all of which shipped broken:
 *  1. Every seeded file declares runtime markers, so nothing is seeded by
 *     accident. `extractRuntimePersona` throws otherwise.
 *  2. No maintainer prose and no bracket-grammar slot survives into the region
 *     that becomes the prompt.
 *  3. The region reads as guidance, not as a numbered script with lettered
 *     branches. "SECTION 3", "Branch C" and "Step 4" are cross-references to a
 *     document the model cannot see, and an agent handed a numbered script
 *     recites it instead of having a conversation.
 */
describe("seeded agent prompts — runtime/authoring split (ADR-104)", () => {
  for (const template of AGENT_TEMPLATES) {
    it(`${template.fileName} declares a runtime region and keeps authoring prose out of it`, async () => {
      const raw = await readPrompt(template.fileName);
      // Throws with an actionable message when markers are missing/unbalanced.
      const { runtime, regionCount } = extractRuntimePersona(raw, template.fileName);
      expect(regionCount).toBeGreaterThan(0);
      expect(runtime.length).toBeGreaterThan(0);
      expect(
        findRuntimeLeaks(runtime),
        `${template.fileName} leaks maintainer prose or an unresolvable bracket placeholder into the ` +
          `seeded persona. Move it outside the runtime markers; a bracket slot specifically is what ` +
          `produced the "Hi, is this [Caller Name]?" line on a real call.`,
      ).toEqual([]);
    });

    it(`${template.fileName} reads as goal-based guidance, not a numbered script`, async () => {
      const runtime = await readRuntimePersona(template.fileName);
      const scaffolding = [
        ...new Set([...runtime.matchAll(/\b(SECTION \d+|Branch [A-D]\b|Step \d+|Reschedule Module)/g)].map((m) => m[0])),
      ];
      expect(
        scaffolding,
        `${template.fileName}'s runtime region still refers to script scaffolding. Those are ` +
          `cross-references to a document the model never sees, and they make the agent recite ` +
          `rather than converse — describe the goal and let it decide the order.`,
      ).toEqual([]);
    });
  }
});
