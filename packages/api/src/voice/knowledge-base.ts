/**
 * A3b — Knowledge Base (PDF/FAQ-text/URL → RAG), per org. Closes the gap the
 * persona prompts (`docs/agent-prompts/01-cart-recovery-agent.md`,
 * `04-insurance-policy-renewal-agent.md`) already promised: "answer only
 * from the merchant's configured knowledge base." Until now nothing backed
 * that instruction — `lookupInfo` was an explicit stub.
 *
 * Scope, deliberately: PDF, pasted text/FAQ, and a single URL fetch per
 * document — not "upload anything" (no site crawling, no scheduled
 * re-sync, no OCR on scanned/image PDFs). That's the tier-3 "KB scope
 * constraint" call from the roadmap: a restriction that keeps this
 * shippable now, not a growth lever to build out further yet.
 *
 * Embeddings via the same AI Gateway every LLM call already goes through
 * (see gateway.ts) — no new provider/vendor dependency. Retrieval is a
 * brute-force in-memory cosine-similarity scan per org (see this file's
 * `searchKnowledgeBase`), not a vector index — see the schema.ts doc
 * comment on `knowledgeChunks` for why that's the right tradeoff at this
 * scale.
 */
import { embed, embedMany, cosineSimilarity } from "ai";
import { eq, and, asc } from "drizzle-orm";
import { PDFParse } from "pdf-parse";
import { db } from "../database";
import { knowledgeDocuments, knowledgeChunks } from "../database/schema";
import { gateway } from "./gateway";

const EMBEDDING_MODEL_ID = process.env.AI_GATEWAY_EMBEDDING_MODEL || "openai/text-embedding-3-small";

function embeddingModel() {
  return gateway.embeddingModel(EMBEDDING_MODEL_ID);
}

// Character-based, not token-based — simple and dependency-free, generous
// enough overlap that a fact split across a chunk boundary is still
// findable from either side.
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_DOCUMENT = 500; // hard cap — bounds embedding cost/time for a single upload

/** Splits on paragraph boundaries where possible, falling back to a hard
 * character cut for a single overlong paragraph — avoids chunk boundaries
 * landing mid-sentence whenever the source text has any structure at all. */
export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= CHUNK_SIZE) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = paragraph.length <= CHUNK_SIZE ? paragraph : "";
    }
    if (paragraph.length > CHUNK_SIZE) {
      // A single paragraph longer than one chunk — hard-split with overlap.
      let start = 0;
      while (start < paragraph.length) {
        const end = Math.min(start + CHUNK_SIZE, paragraph.length);
        chunks.push(paragraph.slice(start, end));
        if (end >= paragraph.length) break;
        start = end - CHUNK_OVERLAP;
      }
      current = "";
    }
  }
  if (current) chunks.push(current);

  return chunks.slice(0, MAX_CHUNKS_PER_DOCUMENT);
}

/** Extracts text from a PDF buffer via pdf-parse (pdfjs under the hood) —
 * text-layer extraction only, no OCR, so a scanned/image-only PDF will
 * come back empty. That's a real limitation, not a bug — flagged in the
 * ingest error message when it happens rather than silently succeeding
 * with zero chunks. */
export async function extractTextFromPdf(buffer: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

/** Fetches a URL and strips it down to plain text — deliberately simple
 * (script/style removal + tag stripping + whitespace collapse), not a full
 * readability/boilerplate-removal pass. Good enough for FAQ/policy pages;
 * a heavily templated marketing site will pull in nav/footer text too. */
export async function extractTextFromUrl(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "WeeberKnowledgeBaseBot/1.0" } });
  if (!res.ok) throw new Error(`Failed to fetch URL (status ${res.status})`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type IngestResult = { ok: true; documentId: number; chunkCount: number } | { ok: false; error: string };

/**
 * Ingests one document end to end: extract text (per sourceType) -> chunk
 * -> embed -> insert `knowledgeDocuments` + `knowledgeChunks` rows.
 * Synchronous/blocking on purpose (no background job queue) — uploads are
 * infrequent, human-scale documents (not a bulk import), so a few seconds
 * of embedding latency on the upload request itself is an acceptable
 * tradeoff against the complexity of a job queue for a first version.
 */
export async function ingestKnowledgeDocument(input: {
  orgId: string;
  title: string;
  sourceType: "text" | "url" | "pdf";
  sourceUrl?: string;
  rawText?: string;
  pdfBuffer?: Uint8Array;
}): Promise<IngestResult> {
  const { orgId, title, sourceType, sourceUrl, rawText, pdfBuffer } = input;

  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({ orgId, title, sourceType, sourceUrl: sourceUrl ?? null, status: "processing" })
    .returning();

  try {
    let text: string;
    if (sourceType === "text") {
      text = rawText ?? "";
    } else if (sourceType === "url") {
      if (!sourceUrl) throw new Error("sourceUrl is required for a URL document");
      text = await extractTextFromUrl(sourceUrl);
    } else {
      if (!pdfBuffer) throw new Error("pdfBuffer is required for a PDF document");
      text = await extractTextFromPdf(pdfBuffer);
    }

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      await db
        .update(knowledgeDocuments)
        .set({ status: "failed", errorMessage: "No extractable text found (empty input, or a scanned/image-only PDF with no text layer)" })
        .where(eq(knowledgeDocuments.id, doc.id));
      return { ok: false, error: "No extractable text found" };
    }

    const { embeddings } = await embedMany({ model: embeddingModel(), values: chunks });

    await db.insert(knowledgeChunks).values(
      chunks.map((chunkTextValue, i) => ({
        documentId: doc.id,
        orgId,
        chunkText: chunkTextValue,
        embedding: embeddings[i]!,
      })),
    );

    await db
      .update(knowledgeDocuments)
      .set({ status: "ready", chunkCount: chunks.length })
      .where(eq(knowledgeDocuments.id, doc.id));

    return { ok: true, documentId: doc.id, chunkCount: chunks.length };
  } catch (err) {
    const message = (err as Error).message;
    await db
      .update(knowledgeDocuments)
      .set({ status: "failed", errorMessage: message })
      .where(eq(knowledgeDocuments.id, doc.id));
    return { ok: false, error: message };
  }
}

export async function listKnowledgeDocuments(orgId: string) {
  return db
    .select({
      id: knowledgeDocuments.id,
      title: knowledgeDocuments.title,
      sourceType: knowledgeDocuments.sourceType,
      sourceUrl: knowledgeDocuments.sourceUrl,
      status: knowledgeDocuments.status,
      errorMessage: knowledgeDocuments.errorMessage,
      chunkCount: knowledgeDocuments.chunkCount,
      createdAt: knowledgeDocuments.createdAt,
    })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.orgId, orgId))
    .orderBy(asc(knowledgeDocuments.createdAt));
}

export async function deleteKnowledgeDocument(orgId: string, documentId: number): Promise<boolean> {
  const deleted = await db
    .delete(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.orgId, orgId)))
    .returning({ id: knowledgeDocuments.id });
  return deleted.length > 0; // knowledgeChunks cascade-delete via the FK
}

export type KnowledgeSearchResult = { chunkText: string; score: number };

/** Minimum cosine similarity to bother returning a chunk — below this, a
 * result is more likely to mislead the agent into a false-confident answer
 * than to help, so it's treated the same as "nothing found." */
const RELEVANCE_THRESHOLD = 0.3;

/**
 * Embeds `query` and returns the top `topK` most similar chunks for this
 * org, above `RELEVANCE_THRESHOLD`. Brute-force cosine similarity over
 * every chunk the org has — see the `knowledgeChunks` schema doc comment
 * for why that's fine at this scale.
 */
export async function searchKnowledgeBase(orgId: string, query: string, topK = 3): Promise<KnowledgeSearchResult[]> {
  const chunks = await db
    .select({ chunkText: knowledgeChunks.chunkText, embedding: knowledgeChunks.embedding })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.orgId, orgId));
  if (chunks.length === 0) return [];

  const { embedding: queryEmbedding } = await embed({ model: embeddingModel(), value: query });

  const scored = chunks
    .map((c) => ({ chunkText: c.chunkText, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .filter((c) => c.score >= RELEVANCE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}
