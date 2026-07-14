import z from "zod";
import { tool } from "ai";
import { searchKnowledgeBase } from "../knowledge-base";

/**
 * A3b: real knowledge-base-backed lookup — was a stub ("Replace with a
 * real lookup... for production use") until this closed the gap the
 * persona prompts already promised ("answer only from the merchant's
 * configured knowledge base").
 *
 * Factory, not a static `tool()` export like every other tool in this
 * directory — this one genuinely needs the calling org's id to know
 * *which* knowledge base to search, and that must come from server-side
 * call context (session/DB), never from the model itself (a model-supplied
 * orgId would be a cross-tenant data-access risk). See agent.ts's
 * `buildVoiceTools`, the one place this factory gets called with a real
 * orgId — every other tool stays a plain shared object.
 */
export function createLookupInfoTool(orgId: string | undefined) {
  return tool({
    description:
      "Search this business's knowledge base (FAQs, policies, uploaded docs) for information the caller " +
      "asks about that you don't already know from your instructions or captured facts. Call this whenever " +
      "the caller asks a factual question outside what you already know — never guess or invent an answer " +
      "instead. If nothing relevant comes back, say you don't have that information rather than making " +
      "something up.",
    inputSchema: z.object({
      query: z.string().describe("What the caller wants to know, phrased as their actual question"),
    }),
    async execute({ query }) {
      if (!orgId) {
        return { query, results: [], note: "No knowledge base is configured for this call." };
      }
      const results = await searchKnowledgeBase(orgId, query, 3);
      if (results.length === 0) {
        return { query, results: [], note: "Nothing relevant found in the knowledge base." };
      }
      return { query, results: results.map((r) => r.chunkText) };
    },
  });
}
