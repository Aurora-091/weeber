/**
 * A5 (phase-a-integrity.md) — an unsourced price claim is a guardrail event.
 *
 * Production call 2 spoke *"cremation services typically run between five
 * thousand and eight thousand dollars"* with no `guardrail_events` row and no
 * source for the figure — reading the persona that produced it
 * (docs/agent-prompts/09-insurance-final-expense-qualifier-agent.md, before
 * this phase's v2 revision), the number wasn't even a model invention: it was
 * written into the prompt itself as an unsourced "typical national cost".
 * That prompt is fixed separately (see the v2 persona file); this module is
 * the general, persona-agnostic backstop — a narrow, deterministic detector
 * over any agent's outbound text, so a claim like this is visible the moment
 * it's spoken, in this vertical or any other, prompt bug or genuine model
 * invention alike.
 *
 * Deliberately a detector, not a blocker (see stream.ts's call site): the
 * false-positive rate is unknown, and cutting off or rewriting a sentence
 * mid-utterance is a worse failure than logging one that turns out to be
 * fine. Phase D decides about blocking, once there's data.
 */

const CURRENCY_SYMBOL = /[$₹]\s?\d/;
const CURRENCY_WORD = /\b(dollars?|rupees?|usd|inr)\b/i;

/**
 * Spelled-out quantity words worth treating as "a number was said" — covers
 * the call-2 sentence ("five thousand", "eight thousand") and the common
 * range/magnitude vocabulary around a price without attempting full
 * number-word parsing (unnecessary here: this only has to notice a number is
 * present, not compute its value).
 */
const NUMBER_WORD =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|crore|million|billion)\b/i;
const DIGIT_AMOUNT = /\d[\d,]*(\.\d+)?/;

/** A number was said, in digits or spelled out. */
function hasQuantity(sentence: string): boolean {
  return NUMBER_WORD.test(sentence) || DIGIT_AMOUNT.test(sentence);
}

/** A currency was named, by symbol or word. */
function hasCurrency(sentence: string): boolean {
  return CURRENCY_SYMBOL.test(sentence) || CURRENCY_WORD.test(sentence);
}

/**
 * Phrases that name where a figure actually came from — a sentence
 * containing one of these is treated as sourced regardless of its currency
 * content. Deliberately generous (a false negative here just means a
 * genuinely sourced sentence isn't flagged, which is the safe direction to
 * be wrong in for a detector that only ever logs).
 */
const SOURCE_INDICATORS = [
  "quote",
  "quoted",
  "quotation",
  "invoice",
  "estimate we sent",
  "estimate you received",
  "your policy",
  "your plan shows",
  "your account shows",
  "your statement",
  "per your",
  "the advisor will",
  "your coverage document",
  "the paperwork shows",
  "tool result",
];

function hasSourceIndicator(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return SOURCE_INDICATORS.some((phrase) => lower.includes(phrase));
}

/** One sentence flagged as an unsourced quantitative cost claim. */
export type UnsourcedClaim = { sentence: string };

/**
 * Splits `text` into sentences and flags each one that names a currency
 * amount (symbol, word, digits, or spelled out) with no nearby source
 * indicator. Pure, synchronous, no I/O — the caller (stream.ts) decides what
 * to do with the result, same separation as `heardInCallerSpeech`.
 */
export function detectUnsourcedPriceClaims(text: string): UnsourcedClaim[] {
  if (!text.trim()) return [];
  // Split on sentence-ending punctuation followed by whitespace — good enough
  // for spoken agent text, which is short, plain sentences by construction
  // (agent.ts's persona explicitly forbids markdown/lists).
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const claims: UnsourcedClaim[] = [];
  for (const sentence of sentences) {
    if (hasCurrency(sentence) && hasQuantity(sentence) && !hasSourceIndicator(sentence)) {
      claims.push({ sentence: sentence.trim() });
    }
  }
  return claims;
}
