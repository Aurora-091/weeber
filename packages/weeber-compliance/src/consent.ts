/**
 * Recording/AI disclosure — meant to be spoken at the start of every call
 * whenever recording is on (default), satisfying the baseline pattern most
 * jurisdictions require: two-party-consent US states, GDPR Art. 6 lawful
 * basis for processing, and the EU AI Act Art. 50 requirement to disclose
 * that the caller is interacting with an AI system.
 *
 * Enforced by default (opt-out via config, not opt-in) so compliance is the
 * out-of-the-box behavior, not something a developer has to remember to wire
 * in per deployment. Environment-variable driven for zero-config use, but
 * every value can be passed explicitly instead if you don't want this
 * package reading process.env directly (e.g. in a non-Node runtime).
 *
 * Global Compliance Engine Tier 0 (2026-07-16, docs/global-compliance-engine-plan.md
 * #2/#3): the disclosure line is now (a) versioned, so a caller can persist which
 * exact wording was spoken on a given call (audit-trail requirement — proving
 * disclosure happened isn't enough without knowing what was actually said), and
 * (b) resolvable per-language, since a single US/EU-shaped English sentence read to
 * a Hindi/Hinglish-speaking caller is not a real disclosure. An explicit
 * `options.disclosureText` override always wins over both the language map and the
 * env var, same priority order as before this change — nothing that previously
 * passed an explicit override changes behavior.
 */
export type ConsentOptions = {
  enabled?: boolean;
  disclosureText?: string;
  /** BCP-47-ish language tag (e.g. "en", "hi", "hi-IN") — selects a localized
   * disclosure line from DISCLOSURE_TEXT_BY_LANGUAGE. Falls back to "en" (the
   * DEFAULT_DISCLOSURE_TEXT) when unset or when no variant exists for the tag. */
  language?: string;
};

/** Bump this whenever the wording of any entry in DISCLOSURE_TEXT_BY_LANGUAGE
 * changes — callers store this alongside the resolved text so an audit record
 * says exactly which version of the disclosure was spoken on a given call, not
 * just "some disclosure was spoken." Independent per explicit-override text
 * (an override has no version of its own — see resolveDisclosure below). */
export const DISCLOSURE_VERSION = "v3-2026-08-27";

// 2026-08-27 (user decision — reword, keep both the recording and AI
// disclosures; see the v2 comment on this constant's history): shorter and
// less clinical than "Quick heads up before we start", and names "quality
// and training" as the recording purpose (a common, caller-familiar framing)
// instead of a bare "may be recorded". Still satisfies the same two legal
// bases the v2 line did — GDPR Art. 6 consent/recording notice and EU AI Act
// Art. 50's AI-interaction disclosure — neither requirement was dropped,
// only the phrasing changed.
const DEFAULT_DISCLOSURE_TEXT =
  "Quick note before we get started — this call may be recorded for quality and training, and I'm an AI assistant.";

/**
 * Localized disclosure lines, keyed by a normalized language tag (lowercased,
 * region suffix stripped — "hi-IN" and "hi" both resolve to "hi"). Hindi/Hinglish
 * wording follows this codebase's existing convention (see docs/agent-prompts/):
 * the "hi" line is Devanagari with English loanwords ("call", "AI assistant") kept
 * in Latin script rather than transliterated — matches the Sarvam STT `codemix` fix
 * (transliterating loanwords into Devanagari was a real, fixed bug elsewhere in
 * this pipeline). The "hinglish" line is the same meaning fully romanized (Latin
 * script), matching how the insurance agent prompts render their Hinglish audited
 * wording — a "hinglish" agent's TTS voice speaks Hindi (Sarvam maps hinglish ->
 * hi-IN) but from romanized text, so the disclosure must match that surface form
 * rather than falling back to the English sentence. Both non-English lines are
 * drafts pending human review before they're spoken on a real call — see
 * docs/global-compliance-engine-plan.md.
 */
const DISCLOSURE_TEXT_BY_LANGUAGE: Record<string, string> = {
  en: DEFAULT_DISCLOSURE_TEXT,
  hi: "शुरू करने से पहले एक छोटी सी बात — यह call quality और training के लिए record हो सकती है, और मैं एक AI assistant हूँ।",
  hinglish:
    "Shuru karne se pehle ek chhoti si baat — yeh call quality aur training ke liye record ho sakti hai, aur main ek AI assistant hoon.",
};

function normalizeLanguageTag(language: string): string {
  const normalized = language.trim().toLowerCase();
  return normalized.split(/[-_]/)[0] ?? normalized;
}

export function isDisclosureEnabled(options: ConsentOptions = {}): boolean {
  if (options.enabled !== undefined) return options.enabled;
  if (typeof process !== "undefined" && process.env?.RECORDING_DISCLOSURE_ENABLED === "false") return false;
  return true;
}

/**
 * Resolves both the disclosure text AND the version identifier a caller
 * should persist alongside a call record. Priority: explicit
 * `options.disclosureText` override (version `"custom"` — it's not one of
 * the versioned built-in lines, so there's nothing meaningful to version)
 * > env var override (also `"custom"`, same reasoning) > language-matched
 * built-in line (real `DISCLOSURE_VERSION`) > English default (also real
 * `DISCLOSURE_VERSION`, it's just DISCLOSURE_TEXT_BY_LANGUAGE.en).
 */
export function resolveDisclosure(options: ConsentOptions = {}): { text: string; version: string } {
  if (options.disclosureText) return { text: options.disclosureText, version: "custom" };
  if (typeof process !== "undefined" && process.env?.RECORDING_DISCLOSURE_TEXT) {
    return { text: process.env.RECORDING_DISCLOSURE_TEXT, version: "custom" };
  }
  const tag = options.language ? normalizeLanguageTag(options.language) : "en";
  const text = DISCLOSURE_TEXT_BY_LANGUAGE[tag] ?? DEFAULT_DISCLOSURE_TEXT;
  return { text, version: DISCLOSURE_VERSION };
}

/** Back-compat convenience — just the text, same resolution order as `resolveDisclosure`. */
export function getDisclosureLine(options: ConsentOptions = {}): string {
  return resolveDisclosure(options).text;
}

/** Prepends the disclosure instruction to a persona/system prompt string. */
export function withDisclosure(personaInstructions: string, options: ConsentOptions = {}): string {
  if (!isDisclosureEnabled(options)) return personaInstructions;
  return `${personaInstructions}\n\nAt the very start of the call, before anything else, say this near-verbatim: "${getDisclosureLine(options)}"`;
}
