import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chunkText, extractTextFromUrl } from "./knowledge-base";

describe("chunkText", () => {
  test("returns an empty array for empty/whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  test("returns a single chunk for short text", () => {
    const chunks = chunkText("Our store hours are 9am to 6pm, Monday through Saturday.");
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("9am to 6pm");
  });

  test("groups multiple short paragraphs into one chunk while under the size limit", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = chunkText(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("Paragraph one.");
    expect(chunks[0]).toContain("Paragraph three.");
  });

  test("splits into multiple chunks once accumulated paragraphs exceed the size limit", () => {
    const paragraph = "x".repeat(500);
    const text = [paragraph, paragraph, paragraph].join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(800);
    }
  });

  test("hard-splits a single paragraph longer than one chunk, with overlap", () => {
    const longParagraph = Array.from({ length: 200 }, (_, i) => `sentence-${i}`).join(" ");
    const chunks = chunkText(longParagraph);
    expect(chunks.length).toBeGreaterThan(1);
    // Overlap: chunk[1] should start exactly 150 chars (CHUNK_OVERLAP) before
    // where chunk[0] ended in the original text — i.e. its first 150 chars
    // reappear as chunk[0]'s last 150 chars.
    expect(chunks[0]!.endsWith(chunks[1]!.slice(0, 150))).toBe(true);
  });

  test("caps the number of chunks per document", () => {
    const hugeText = Array.from({ length: 2000 }, (_, i) => `Paragraph number ${i} with some content.`).join("\n\n");
    const chunks = chunkText(hugeText);
    expect(chunks.length).toBeLessThanOrEqual(500);
  });
});

describe("extractTextFromUrl", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // @ts-expect-error test stub
    global.fetch = undefined;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("strips scripts, styles, and tags, leaving readable text", async () => {
    const html = `
      <html><head><style>.a{color:red}</style><script>alert(1)</script></head>
      <body><h1>Store Hours</h1><p>We're open 9am to 6pm.</p><p>Closed Sundays.</p></body></html>
    `;
    global.fetch = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const text = await extractTextFromUrl("https://example.com/faq");
    expect(text).toContain("Store Hours");
    expect(text).toContain("open 9am to 6pm");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("<p>");
  });

  test("decodes common HTML entities", async () => {
    const html = "<p>Terms &amp; Conditions apply &nbsp;&mdash; see &lt;details&gt;</p>";
    global.fetch = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const text = await extractTextFromUrl("https://example.com/terms");
    expect(text).toContain("Terms & Conditions");
  });

  test("throws a clear error for a non-2xx response", async () => {
    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(extractTextFromUrl("https://example.com/missing")).rejects.toThrow(/404/);
  });
});
