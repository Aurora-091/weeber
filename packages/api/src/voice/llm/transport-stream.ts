import { formatTransportLink, type LlmTransportLink } from "./transport-chain";

/**
 * ADR-109 — executes an LLM transport chain, and closes the retry window at
 * the first token.
 *
 * **The retry window is the entire design constraint.** In a chat UI a failed
 * generation can be retried invisibly. On a voice call it cannot: the moment a
 * delta leaves this generator it reaches `createOutputGuard` in agent.ts, then
 * TTS, then the caller's ear. Retrying a different model after that point makes
 * the agent say two different things in one turn, and the caller has already
 * heard the first one — a worse failure than the one being recovered from, and
 * unrecoverable because audio cannot be un-sent.
 *
 * So `produced` is tracked across the whole run, not per link, and any failure
 * after the first yielded chunk rethrows instead of failing over. This is
 * sufficient for the defect ADR-109 exists to fix: the gateway's
 * bedrock-400-then-groq-503 failure happens at request establishment, before a
 * single content delta exists. Mid-stream failover is therefore deliberately
 * NOT built — it is not a gap, it is the boundary.
 *
 * An abort also never retries. A barge-in or a turn timeout means the caller
 * stopped wanting this answer; spending another provider's latency to finish
 * producing it is work nobody is waiting for.
 */
export async function* streamWithTransportFailover<T>(input: {
  /** Primary first, then fallbacks. A single-element list = no failover. */
  links: LlmTransportLink[];
  /** Opens a stream for one link. Called at most once per link, lazily. */
  open: (link: LlmTransportLink) => AsyncIterable<T>;
  /** Called when a link failed before producing anything and another will be tried. */
  onAttemptFailed?: (info: { link: LlmTransportLink; error: unknown; attempt: number }) => void;
  /** Called once the link that actually produced output is known. */
  onLinkResolved?: (link: LlmTransportLink) => void;
  /** True once the caller has given up on this turn (barge-in / timeout). */
  isAborted?: () => boolean;
}): AsyncGenerator<T> {
  const { links, open, onAttemptFailed, onLinkResolved, isAborted } = input;
  if (links.length === 0) throw new Error("[llm-transport] no transport links to try");

  let produced = false;
  for (let attempt = 0; attempt < links.length; attempt++) {
    const link = links[attempt]!;
    try {
      for await (const chunk of open(link)) {
        if (!produced) {
          produced = true;
          onLinkResolved?.(link);
        }
        yield chunk;
      }
      return;
    } catch (error) {
      // Past the first token there is no second chance — see the doc comment.
      if (produced) throw error;
      if (isAborted?.()) throw error;
      const isLast = attempt === links.length - 1;
      if (isLast) throw error;
      onAttemptFailed?.({ link, error, attempt });
      console.warn("[llm-transport] link failed before first token — trying next", {
        failed: formatTransportLink(link),
        next: formatTransportLink(links[attempt + 1]!),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
