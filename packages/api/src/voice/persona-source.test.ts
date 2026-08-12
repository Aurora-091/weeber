import { describe, it, expect } from "bun:test";
import {
  extractRuntimePersona,
  findRuntimeLeaks,
  PersonaSourceError,
  RUNTIME_BEGIN,
  RUNTIME_END,
} from "./persona-source";

/**
 * Unit-level edge cases for the persona runtime/authoring split (ADR-104).
 * The cross-file assertions — every seeded prompt declares markers, keeps
 * authoring prose out, and reads as guidance rather than a numbered script —
 * live in `database/prompt-hygiene.test.ts`, next to the other prompt gates.
 *
 * The single most important behaviour here is the *absence* of a fallback. A
 * "markers missing, so seed the whole file" path would silently restore the
 * defect this module removes, and would do it the moment someone adds a tenth
 * prompt file — the same shape as the seeder's earlier off-by-one, which skipped
 * every template while logging success.
 */
const doc = (body: string) => `# Title\n\nauthoring prose\n\n${RUNTIME_BEGIN}\n${body}\n${RUNTIME_END}\n\ntrailing prose\n`;

describe("extractRuntimePersona", () => {
  it("returns only the marked region, trimmed, and never the surrounding document", () => {
    const result = extractRuntimePersona(doc("You are a helpful assistant."), "x.md");
    expect(result.runtime).toBe("You are a helpful assistant.");
    expect(result.regionCount).toBe(1);
    expect(result.runtime).not.toContain("authoring prose");
    expect(result.runtime).not.toContain("trailing prose");
    expect(result.runtimeChars).toBeLessThan(result.sourceChars);
  });

  it("supports several regions so a file can interleave persona and commentary", () => {
    const source = [
      "# Title",
      RUNTIME_BEGIN,
      "first",
      RUNTIME_END,
      "editor-only paragraph",
      RUNTIME_BEGIN,
      "second",
      RUNTIME_END,
    ].join("\n");
    const result = extractRuntimePersona(source, "x.md");
    expect(result.regionCount).toBe(2);
    expect(result.runtime).toBe("first\n\nsecond");
    expect(result.runtime).not.toContain("editor-only");
  });

  it("throws rather than falling back to the whole document when markers are absent", () => {
    expect(() => extractRuntimePersona("# Title\n\nall of it\n", "x.md")).toThrow(PersonaSourceError);
    // The message has to tell the author what to do, since this fires at seed
    // time in production logs as well as in CI.
    expect(() => extractRuntimePersona("# Title\n", "nine.md")).toThrow(/nine\.md.*runtime:begin/s);
  });

  it("throws on unbalanced, unclosed, nested, or reversed markers", () => {
    expect(() => extractRuntimePersona(`${RUNTIME_BEGIN}\nbody\n`, "x.md")).toThrow(/unbalanced/);
    expect(() => extractRuntimePersona(`${RUNTIME_END}\nbody\n${RUNTIME_BEGIN}\n`, "x.md")).toThrow(
      /before the first/,
    );
    expect(() =>
      extractRuntimePersona(`${RUNTIME_BEGIN}\n${RUNTIME_BEGIN}\nbody\n${RUNTIME_END}\n${RUNTIME_END}`, "x.md"),
    ).toThrow(/nested/);
  });

  it("throws on an empty region instead of seeding an empty persona", () => {
    expect(() => extractRuntimePersona(doc("   \n  "), "x.md")).toThrow(/empty runtime region/);
  });
});

describe("findRuntimeLeaks", () => {
  it("flags maintainer prose that drifted inside the markers", () => {
    expect(findRuntimeLeaks("**File:** `09-agent.md`")).toHaveLength(1);
    expect(findRuntimeLeaks("## Tools — explicit mapping")).toHaveLength(1);
    expect(findRuntimeLeaks("Known gap, flagged not hidden: no presence check")).toHaveLength(1);
  });

  it("flags bracket-grammar slots — the call-24 defect", () => {
    // Spoken verbatim on a real production call: "Hi, is this [Caller Name]?
    // This is [Agent Name] with presistentads". The merge layer only resolves
    // double-brace tags, so it stripped the tag inside the brackets and left
    // the label standing for the model to read out.
    const leaks = findRuntimeLeaks("Hi, is this [Caller Name]? This is [Agent_name: ] with us.");
    expect(leaks).toHaveLength(2);
    expect(leaks.join(" ")).toContain("[Caller Name]");
  });

  it("does not flag ordinary markdown brackets or lowercase option lists", () => {
    expect(findRuntimeLeaks("see [the docs](https://example.com) and answer [yes/no]")).toEqual([]);
    expect(findRuntimeLeaks("capture it as [optional] context")).toEqual([]);
  });

  it("passes clean guidance prose", () => {
    expect(findRuntimeLeaks("You are {{agent_name}}, a warm intake assistant for {{company_name}}.")).toEqual([]);
  });
});
