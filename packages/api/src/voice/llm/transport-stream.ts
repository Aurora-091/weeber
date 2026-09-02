import { formatTransportLink, type LlmTransportLink } from "./transport-chain";

/**
 * Thrown when every link in the chain failed (or timed out) before producing
 * a single token. Distinct from a plain Error so a caller (agent.ts) can tell
 * "the whole chain is down, give the caller a fallback reply" apart from an
 * abort or a bug — see FIRST_TOKEN_TIMEOUT_MS's doc comment for why this is
 * now a routine, expected outcome rather than an exceptional one.
 */
export class TransportChainExhaustedError extends Error {
  constructor(public readonly lastLink: LlmTransportLink, options: { cause?: unknown }) {
    super(`[llm-transport] every link failed before first token (last: ${formatTransportLink(lastLink)})`, options);
    this.name = "TransportChainExhaustedError";
  }
}

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
 * after the first yielded chunk rethrows instead of failing over. Originally
 * this chain only failed over on a thrown error — sufficient for the defect
 * ADR-109 was built for (the gateway's bedrock-400-then-groq-503 failure,
 * which happens at request establishment). It did nothing for a link that is
 * merely SLOW: a request that eventually streams a successful response never
 * throws, so a stuck gateway just sat there for however long it wanted.
 * Production data (2026-08-27 spike, retraced 2026-09-02) showed exactly that
 * shape — `llm_ttft_ms` up to 9990ms on a `gateway/...` link that never
 * errored — which the original error-only chain could not have caught even
 * with the flag on. `firstTokenTimeoutMs` (below) closes that gap: a link gets
 * a bounded window to produce its first chunk, timeout or not.
 *
 * An abort also never retries. A barge-in or a turn timeout means the caller
 * stopped wanting this answer; spending another provider's latency to finish
 * producing it is work nobody is waiting for.
 */
export async function* streamWithTransportFailover<T>(input: {
  /** Primary first, then fallbacks. A single-element list = no failover. */
  links: LlmTransportLink[];
  /** Opens a stream for one link, given the AbortSignal that governs THIS
   * attempt only (already combined with `signal` below). Called at most once
   * per link, lazily. */
  open: (link: LlmTransportLink, signal: AbortSignal) => AsyncIterable<T>;
  /** Called when a link failed before producing anything and another will be tried. */
  onAttemptFailed?: (info: { link: LlmTransportLink; error: unknown; timedOut: boolean; attempt: number }) => void;
  /** Called once the link that actually produced output is known. */
  onLinkResolved?: (link: LlmTransportLink) => void;
  /** True once the caller has given up on this turn (barge-in / timeout). */
  isAborted?: () => boolean;
  /** The turn-level abort (barge-in / TURN_TIMEOUT_MS). Aborting this always
   * cancels whichever link is currently open and is never itself treated as a
   * per-link failure to fail over from — see the `isAborted` check below. */
  signal?: AbortSignal;
  /**
   * Ceiling on waiting for a link's FIRST chunk. A link that produces nothing
   * within this window is aborted and treated exactly like a thrown error —
   * failed over to the next link, or (on the last link) surfaced as
   * `TransportChainExhaustedError`. No effect once the turn's first chunk has
   * been produced (see the module doc: the retry window is closed then).
   *
   * Deliberately applied uniformly, including to the last link: a bounded
   * failure (roughly `links.length * firstTokenTimeoutMs` worst case) is a
   * better caller experience than one link silently eating the whole
   * `TURN_TIMEOUT_MS` budget in dead air, which is what the data showed
   * happening. Omit to preserve the original wait-as-long-as-it-takes
   * behavior for a single link (i.e. when the chain is empty/flag off).
   */
  firstTokenTimeoutMs?: number;
}): AsyncGenerator<T> {
  const { links, open, onAttemptFailed, onLinkResolved, isAborted, signal, firstTokenTimeoutMs } = input;
  if (links.length === 0) throw new Error("[llm-transport] no transport links to try");

  let produced = false;
  for (let attempt = 0; attempt < links.length; attempt++) {
    const link = links[attempt]!;
    const linkController = new AbortController();
    const abortLink = () => linkController.abort();
    if (signal?.aborted) abortLink();
    else signal?.addEventListener("abort", abortLink);

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const iterator = open(link, linkController.signal)[Symbol.asyncIterator]();
      let next: IteratorResult<T>;
      if (!produced && firstTokenTimeoutMs !== undefined) {
        const firstChunk = iterator.next();
        // A rejection from the losing side of the race below would otherwise
        // be an unhandled rejection once we move on to the next link.
        firstChunk.catch(() => {});
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve("timeout");
          }, firstTokenTimeoutMs);
        });
        const raced = await Promise.race([firstChunk, timeout]);
        clearTimeout(timer);
        if (raced === "timeout") {
          abortLink();
          void iterator.return?.().catch(() => {});
          throw new Error(`[llm-transport] ${formatTransportLink(link)} produced no output within ${firstTokenTimeoutMs}ms`);
        }
        next = raced;
      } else {
        next = await iterator.next();
      }
      while (!next.done) {
        if (!produced) {
          produced = true;
          onLinkResolved?.(link);
        }
        yield next.value;
        next = await iterator.next();
      }
      return;
    } catch (error) {
      // Past the first token there is no second chance — see the doc comment.
      if (produced) throw error;
      if (isAborted?.()) throw error;
      const isLast = attempt === links.length - 1;
      if (isLast) throw new TransportChainExhaustedError(link, { cause: error });
      onAttemptFailed?.({ link, error, timedOut, attempt });
      console.warn(`[llm-transport] link failed before first token${timedOut ? " (timeout)" : ""} — trying next`, {
        failed: formatTransportLink(link),
        next: formatTransportLink(links[attempt + 1]!),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortLink);
    }
  }
}
