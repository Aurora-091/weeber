/**
 * Prompt-injection detection over raw caller speech.
 *
 * Best-effort, defense-in-depth, and **log-only** — `stream.ts` records a
 * `guardrail-heuristic-detector` tool call for dashboard review and then lets
 * the turn proceed exactly as it would have. Nothing here blocks a caller or
 * changes what the model says. That is deliberate: the model's own
 * `flagGuardrailEvent` is the primary path, and this exists so an attempt is
 * still visible when the model doesn't self-report. A false positive costs one
 * noisy dashboard row; a false negative costs the only evidence that someone
 * probed a live agent.
 *
 * ## G1.5 (2026-08-01) — why the English-only set could not work
 *
 * Until this change the detector was nine English regexes of the shape
 * `verb ... object` (`ignore\s+...instructions?`). Two independent reasons that
 * misses on the calls this product actually places:
 *
 * 1. **Hindi and Hinglish are SOV.** The verb lands *after* its object:
 *    "saare instructions bhool jao", "अपने सारे निर्देश भूल जाओ". A
 *    `verb-then-object` pattern cannot match a sentence whose verb comes last,
 *    no matter how many synonyms are added to it.
 * 2. **Romanized Hinglish has no fixed spelling.** bhool / bhul / bhuul,
 *    karo / karro, nazarandaz / nazrandaz / najarandaj. Enumerating literal
 *    phrases is a losing game.
 *
 * So the second layer here is **order-independent co-occurrence**: an
 * override/disclosure verb stem appearing within a short window of an
 * instruction noun stem, in either order, in either script. Stems, not whole
 * words — Devanagari inflects by suffix (भूल → भूलो, भूलकर, भूल जाओ) so a stem
 * prefix match covers the conjugations for free.
 *
 * Note that `\b` is useless around Devanagari in JS regex (those code points
 * aren't `\w`), which is a second reason this layer matches stems rather than
 * bounded words.
 */

/** Characters within which a verb stem and a noun stem count as one phrase. */
const CO_OCCURRENCE_WINDOW = 45;

/**
 * Layer 1 — English literal phrases. Unchanged from the original set; these
 * are precise and there is no reason to loosen them.
 */
const INJECTION_PHRASE_PATTERNS = [
  /ignore\s+(all|your|the|any)?\s*(previous|prior|above)?\s*instructions?/i,
  /disregard\s+(your|the|any)?\s*(previous|prior)?\s*instructions?/i,
  /forget\s+(your|the)?\s*(rules|instructions|prompt|guidelines)/i,
  /you('re| are)\s+now\s+(a|an)\b/i,
  /pretend\s+(you'?re|to be|you are)/i,
  /act\s+as\s+(if|a|an)\b/i,
  /reveal\s+your\s+(system\s+)?(prompt|instructions)/i,
  /what\s+(is|are)\s+your\s+(system\s+)?(prompt|instructions)/i,
  // `an\s+` added in G1.5 — the original alternation was `(the\s+|a\s+)?`, so
  // "I'm an administrator" slipped through the one pattern written to catch it.
  /i('m| am)\s+(the\s+|an?\s+)?(developer|admin|administrator)\b/i,
];

/**
 * Layer 2a — things a caller asks an agent to *do to* its instructions.
 * Romanized Hinglish stems plus their Devanagari equivalents.
 * bhool/भूल = forget · hatao/हटा = remove · chhodo/छोड़ = drop ·
 * nazarandaz/नजरअंदाज + anadekha/अनदेखा = ignore · todo/तोड़ = break ·
 * badlo/बदल = change · update karo = overwrite.
 */
const OVERRIDE_VERB_STEMS =
  /(bhool|bhul|bhuul|bhoolo|ignore|disregard|nazarandaz|nazrandaz|najarandaj|anadekha|andekha|hata\s*do|hatao|chhod|chod|tod\s*do|todo|badal|badlo|overwrite|override|भूल|हटा|छोड|तोड|अनदेखा|नजरअंदाज|बदल|रद्द)/i;

/**
 * Layer 2b — things a caller asks an agent to *disclose*.
 * batao/बता = tell · dikhao/दिखा = show · padho/पढ़ = read out ·
 * sunao/सुना = recite · kya hai/क्या है = what is.
 */
const DISCLOSURE_VERB_STEMS =
  /(batao|bata\s*do|bataiye|batayen|dikhao|dikha\s*do|dikhaiye|padho|padhkar|sunao|sunaiye|reveal|repeat|print|kya\s*h(ai|ain|ain\b|e)|बताओ|बता\s*दो|बताइए|दिखाओ|दिखा\s*दो|पढ|सुना|क्या\s*ह)/i;

/**
 * Layer 2c — the object a verb has to land on for this to be an injection
 * attempt rather than ordinary conversation. **System-internal nouns only.**
 * nirdesh/निर्देश + hidayat/हिदायत + aadesh/आदेश = instructions ·
 * prompt/प्रॉम्प्ट · script/स्क्रिप्ट.
 *
 * `rule` / `niyam` / `नियम` are deliberately **not** here: "batao ki return ka
 * niyam kya hai" ("tell me what the return policy is") is a completely ordinary
 * thing for a customer to ask, and pairing it with a disclosure verb produced a
 * false positive on exactly that sentence.
 */
const INSTRUCTION_NOUN_STEMS =
  /(instruction|nirdesh|nirdeshon|hidayat|hidayaten|aadesh|adesh|guideline|prompt|system\s*message|persona|script|निर्देश|हिदायत|आदेश|प्रॉम्प्ट|प्रॉम्पट|सिस्टम\s*प्रॉम्प्ट|स्क्रिप्ट|गाइडलाइन)/i;

/**
 * What an *override* verb may land on. Wider than the disclosure set: telling
 * an agent to forget or delete its rules is an attack even though asking what
 * the rules are is not.
 *
 * Known, accepted false positive: "main niyam bhool gaya" ("I forgot the
 * rules") trips this. It is log-only, and under-detecting an override attempt
 * is the worse error.
 */
const OVERRIDE_TARGET_STEMS =
  /(instruction|nirdesh|nirdeshon|hidayat|hidayaten|aadesh|adesh|niyam|niyamon|rule|guideline|prompt|system\s*message|persona|script|निर्देश|हिदायत|आदेश|नियम|प्रॉम्प्ट|प्रॉम्पट|सिस्टम\s*प्रॉम्प्ट|स्क्रिप्ट|गाइडलाइन)/i;

/**
 * Layer 3 — claims of privileged identity, which are an injection attempt on
 * their own without needing an object.
 * main/मैं = I · banane wala/बनाने वाला = the one who built you ·
 * malik/मालिक = owner.
 */
const AUTHORITY_CLAIM_PATTERNS = [
  /\b(main|mai|mein|me)\s+(hi\s+)?(tumhara|tumhare|tera|aapka|aapke|is\s+company\s+ka)?\s*(developer|devloper|admin|adminstrator|engineer|programmer|malik|owner|banane\s*wala|banane\s*vala)\b/i,
  /(मैं|मै)\s*(ही\s*)?(तुम्हारा|तुम्हारे|तेरा|आपका|आपके)?\s*(डेवलपर|डेव्हलपर|एडमिन|इंजीनियर|प्रोग्रामर|मालिक|बनाने\s*वाला)/,
];

/**
 * Layer 4 — roleplay imperatives. `ban jao` / `बन जाओ` ("become a…") and
 * `naatak karo` / `नाटक करो` ("pretend") are distinctive enough to stand
 * alone: a customer asking about an order does not use them.
 */
const ROLEPLAY_PATTERNS = [
  /\b(ab\s+)?(tum|tu|aap)\s+(ek\s+)?\S+\s+(ban\s*jao|ban\s*ja|bano|ho\s+gaye)\b/i,
  /\bban\s*jao\b/i,
  /\b(naatak|natak|nautanki)\s*(karo|kar)\b/i,
  /\brole\s*play\s*(karo|kar)?\b/i,
  /(अब\s*)?(तुम|तू|आप)\s*(एक\s*)?\S*\s*(बन\s*जाओ|बन\s*जा|बनो)/,
  /(नाटक|नौटंकी)\s*कर/,
];

/**
 * Devanagari carries the same consonant two ways — precomposed (ज़ U+095B) or
 * base + nukta (ज U+091C + U+093C). STT providers are not consistent about
 * which they emit. Decompose, drop the nukta, recompose: नज़रअंदाज़ and
 * नजरअंदाज collapse to one form so the stems above only need spelling once.
 */
export function normalizeForInjectionCheck(text: string): string {
  return text.normalize("NFD").replace(/़/g, "").normalize("NFC");
}

function matchIndices(pattern: RegExp, text: string): number[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const scanner = new RegExp(pattern.source, flags);
  const out: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    out.push(match.index);
    // Zero-length match guard — otherwise exec never advances.
    if (match.index === scanner.lastIndex) scanner.lastIndex += 1;
  }
  return out;
}

function coOccursWithin(text: string, a: RegExp, b: RegExp, window: number): boolean {
  const aIndices = matchIndices(a, text);
  if (aIndices.length === 0) return false;
  const bIndices = matchIndices(b, text);
  if (bIndices.length === 0) return false;
  return aIndices.some((i) => bIndices.some((j) => Math.abs(i - j) <= window));
}

export function looksLikePromptInjection(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForInjectionCheck(text);

  if (INJECTION_PHRASE_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (AUTHORITY_CLAIM_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (ROLEPLAY_PATTERNS.some((pattern) => pattern.test(normalized))) return true;

  if (coOccursWithin(normalized, OVERRIDE_VERB_STEMS, OVERRIDE_TARGET_STEMS, CO_OCCURRENCE_WINDOW)) {
    return true;
  }
  if (coOccursWithin(normalized, DISCLOSURE_VERB_STEMS, INSTRUCTION_NOUN_STEMS, CO_OCCURRENCE_WINDOW)) {
    return true;
  }

  return false;
}
