import z from "zod";
import { tool } from "ai";

/**
 * Stub tool — demonstrates the tool-calling path end to end during a live call.
 * Replace with a real lookup (CRM, knowledge base, DB, etc.) for production use.
 */
export const lookupInfo = tool({
  description:
    "Look up general information the caller asks for (hours, pricing, availability, etc). Use this whenever the caller asks a factual question you don't already know the answer to.",
  inputSchema: z.object({
    query: z.string().describe("What the caller wants to know"),
  }),
  async execute({ query }) {
    // Stub: echoes back a canned response. Wire this to a real data source.
    return {
      query,
      result: `(stub) No live data source connected yet — would look up "${query}" here.`,
    };
  },
});
