# Insurance language variants (en / hi / hinglish) — task

Goal: insurance agents 04–08 become config-driven single-language-per-agent (merchant picks
`language` at setup, TTS locked). US Final Expense (09) stays English-only (done).

## Design (approved)
- Structure: base template config-driven; US final-expense English-only fork kept separate.
- Modes: `en`, `hi`, `hinglish` — three distinct switchable variants, merchant picks one fixed.
- Hybrid audited wording:
  - GREETING = canned-spoken (`literalGreetingTemplate` → speakCannedLine) → needs per-language
    audited strings (code-side map, no DB migration).
  - REFUSALS + CLOSINGS = LLM-delivered but AUDITED by living verbatim in the prompt .md per
    language; LLM instructed to deliver verbatim in the configured language.
  - Rest of conversation = canonical English source; LLM conducts it in the chosen language.
- Disclosure already audited per-language via @openvent/compliance (DO NOT TOUCH).

## Steps
1. [x] agent-frame.ts: add `hinglish` to RECOMMENDED_LANGUAGES + SARVAM_PREFERRED_LANGUAGES.
2. [x] tts/sarvam.ts: map `hinglish` → `hi-IN` in toSarvamLanguageCode.
3. [x] agent.ts: buildLanguageInstructionBlock hinglish branch; localize greeting in
       resolveAgentConfig (use static map; null greeting for languages with no audited variant).
4. [x] new file: insurance-greetings.ts — localized greeting map per insurance template key.
5. [x] stream.ts: relax greeting gate (speak whenever literalGreetingTemplate present, since
       resolveAgentConfig now guarantees language-appropriate text).
6. [x] prompts 04–08: strip inline EN/HI from non-sensitive sections; add audited per-language
       "Audited wording" section for greeting/refusals/closings; guardrails → fixed single language, no
       mid-call switch. (04, 05, 06 done earlier; 07, 08 done 2026-07-19.)
7. [x] agents.tsx: extend Groq/Hinglish warning to hinglish too (minor).
8. [x] tests: hinglish language block (agent-frame.test.ts), greeting localization
       (insurance-greetings.test.ts + agent.test.ts resolveAgentConfig), sarvam mapping (sarvam.test.ts).
9. [x] verify: test 565 pass (was 541, +24 new); typecheck 3/3; lint 0 warnings; build ✓ (2026-07-19).
10. [x] commit + push to main.

## Notes / constraints
- NEVER touch @openvent/compliance (STOP-AND-ASK).
- Compliance hard line unchanged: qualify→educate→transfer/book; no quote/underwrite/regulated data.
- Repo: bun install --frozen-lockfile then bun run test (never bare bun test). build before commit.

## Follow-up / flagged gaps (not done — need a decision)
- @openvent/compliance disclosure has NO `hinglish` key (only en/hi). A Hinglish agent currently
  gets the English default disclosure (falls back gracefully, no crash). The Hindi disclosure line is
  already code-mixed and would fit Hinglish — but touching the compliance package is STOP-AND-ASK, so
  this is left for explicit approval. Add `hinglish` (or alias it to `hi`) in
  packages/openvent-compliance/src/consent.ts DISCLOSURE_TEXT_BY_LANGUAGE if we want a localized
  disclosure for Hinglish calls.
