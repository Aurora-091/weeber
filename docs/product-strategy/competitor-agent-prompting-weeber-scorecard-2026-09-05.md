# Weeber vs competitor prompting — scorecard (2026-09-05)

**Date:** 2026-09-05. **Not a public/decision doc.** Applies the checklist in
[`competitor-agent-prompting-2026-09-05.md`](./competitor-agent-prompting-2026-09-05.md) to
**this repo as it stands on `main`**: nine seeded runtime regions (ADR-104
`<!-- runtime:begin -->` … `<!-- runtime:end -->`), `composeSystemPrompt` /
`buildCallControlBlock` in `packages/api/src/voice/agent.ts`, and the tool
`description` strings under `packages/api/src/voice/tools/`. Authoring tables
below the markers were not scored (the model never sees them). Unseeded
`09-insurance-final-expense-qualifier-agent.md` (v1) was not scored (ADR-118).

No persona, pipeline, or `weeber-compliance` change ships with this note.
Persona edits remain STOP-AND-ASK.

Counts below were taken by extracting each `AGENT_TEMPLATES` runtime with
`extractRuntimePersona` (same path as `seed.ts`).

## Verdict in one page

Weeber already matches the **shared spoken-turn hygiene** the vendors
converged on, and in two places we are *stricter* than their docs: server-bound
tools (ADR-066 / ADR-069) and “tool schema alone is not enough” (production
batched `captureField` until the same instruction was copied into call-control).

Where we fail the competitor bar is the same place the 2026-09-05 founder
calls failed: **runtime prose still orders tools and completed outcomes the
call may not have**, and **one insurance close-set is missing a branch**.
That is not a Vapi-template problem. It is an honesty problem in three
seeded files.

| Competitor rule | Weeber | Grade |
|---|---|---|
| Section the prompt | Runtime uses `## Who you are` / speak / goal / open / close / `Guardrails — these override everything above`. Call-control is a separate composed segment. | **Match** |
| ~2 spoken sentences / turn | Eight of nine runtimes say two lines (or “at most two lines / sixty words”). `04` says “Two-line cap per turn” in guardrails. Call-control does not repeat the cap. | **Match** |
| No markdown in **spoken** output | ADR-106 lives in call-control (“plain sentences only”). Headings in the *system* prompt are Vapi/ElevenLabs-style structure, not TTS input. | **Match** (do not “fix” by flattening `##`) |
| Numbers as words | Runtimes + call-control India format line (lakh/crore, day-then-month, confirm “kal”). | **Match** |
| Guardrails override the script | Every seeded runtime has an explicit override heading. Enforcement is still `flagGuardrailEvent` + `weeber-compliance`, not the heading. | **Match** (prompt is not the boundary — as designed) |
| Tool **when** on the tool object | `hangUp`, `transferToHuman`, `captureField`, `crmSync`, `lookupInfo`, `sendSms` descriptions carry when/when-not. `bookAppointment` is thin (“once you’ve confirmed a date/time”). | **Mostly match** — appointment tool is the weak description |
| Filler on the **tool object** | Global 400ms filler in `stream.ts` / `TOOL_CALL_FILLER_THRESHOLD_MS`, not a per-tool spoken string operators can edit. | **Partial** — works; not the competitor UX |
| Prompt is not a security boundary | Non-registration (ADR-064); CRM/transfer/discount/COD omitted when unbound; `heard` provenance on capture. | **Match** (stronger than Vapi docs) |
| Capability language, not slugs | Mixed. See per-agent table. Call-control still names `hangUp` / `captureField` / `transferToHuman` **on purpose** (tool schema was ignored in production). | **Fail on 06/07/09 slugs; pass on CRM in 06/09** |
| Per-state tool lists | Narrowed at `"start"` only: transfer number, CRM creds (ADR-122), cart discount, COD order. Not per conversation node. `hangUp` is **always** registered. | **Partial** — Retell/Bolna default; we have two gates |
| Hang-up / closing as a module | Each persona pastes its own close-set. `hangUp` description requires a spoken line; ADR-124 skips the hearing apology if the model still hangs up silent. | **Fail on 07** (no documents-not-received close) |
| Completed transfer must not be narrated | Call-control (ADR-105) says never “You’re connected”. Appointment-setter runtime **audits that exact forbidden line** in EN/HI/Hinglish. | **Fail on 06** |
| Numbered persona scripts | No `Step N` / `Section N` inside runtime. Authoring tools tables still say “Section 3”. | **Match** in runtime |
| Keyword-only DNC | No “if they say stop, hang up” in runtime. Compliance is code. | **Match** (do not add) |

## Per seeded agent (runtime only)

Slug counts are `\btoolName\b` hits inside the extracted runtime, not the
authoring `## Tools` table.

| Template | Chars | Slugs in runtime | Honesty vs withheld tools | Close-set hole |
|---|---|---|---|---|
| `01` cart recovery | 6738 | `offerCartRecoveryDiscount` 1, `captureField` 2, `setDisposition` 1, `setIntent` 1 | **Best in repo:** “If you are not holding that tool on this call, the merchant configured no discount — say nothing about a discount.” Matches the second gate in `buildVoiceTools`. | None scored |
| `02` COD | 6447 | `captureField` 1, `setDisposition` 1, `setIntent` 1 | **Does not name `confirmCodOrder`.** Cancellation is described as a capability with a second-no rule; when lives on the tool schema. | None scored |
| `03` feedback | 5645 | `captureField` 3, `setDisposition` 1, `setIntent` 1 | No CRM/transfer. Fine for this job. | None scored |
| `04` renewal | 8354 | `flagGuardrailEvent` 1 only | `crmSync` and `transferToHuman` are on `defaultTools` but **not named** in runtime. Closest insurance file to Vapi capability style. | Human-follow-up close exists; transfer still depends on a number the persona does not mention |
| `05` lead follow-up | 8586 | `captureField` 2, `flagGuardrailEvent` 1 | Same: `bookAppointment` + `crmSync` on the default list, not in runtime. Booking “when” is only on the thin tool description. | None scored |
| `06` appointment setter | 8163 | `transferToHuman` 1, `bookAppointment` 1, `flagGuardrailEvent` 2 | CRM already uses capability language (“If a CRM logging tool is available… skip”). Transfer is still `Call transferToHuman`. **Audited live-transfer close is “You’re connected”** (EN) / “आप connect हो गए हैं” / “Aap connect ho gaye hain” — contradicts ADR-105 call-control. Founder org has no `humanTransferNumber`. | Live-transfer close is the wrong *kind* of line, not a missing branch |
| `07` post-sale welcome | 9061 | `captureField` 2, **`crmSync` 1**, `flagGuardrailEvent` 1 | **Names `crmSync` in runtime** after documents-not-received. ADR-122 will withhold the tool on an org with no CRM; the persona still orders it. This is the exact 2026-09-05 post-sale failure shape (plus silent hangup). | Closings: everything confirmed / needs licensed human / callback. **No documents-not-received closing.** Body tells the model to capture + `crmSync`; then “Deliver exactly, then end the call.” |
| `08` NPS | 7713 | `captureField` 3, `flagGuardrailEvent` 1 | `crmSync` + `transferToHuman` on default list, not named. | None scored |
| `09` final-expense v2 | 12281 | `captureField` **6**, `transferToHuman` 1, `bookAppointment` 1, `sendSms` 1, `flagGuardrailEvent` 4 | CRM: capability language (same sentence as 06). Capture/transfer/SMS still slugs. Close says “matching what actually happened — connected to the advisor” — softer than 06 but still past-tense connect. | No audited “you’re through” line; still a completed-handoff *shape* |

`hangUp` is never named in any runtime. Call-control always names it. That is
the Bolna “hang-up module” we actually have — one composed block, not nine
copies — and it is why silent hangup became ADR-124 rather than “the persona
forgot the word hangUp.”

## Call-control vs Vapi “put when on the tool”

Vapi’s docs say the model attends to the function description. Weeber already
falsified “description-only” on production calls 1 and 2: `captureField`’s
schema said “call immediately, do not batch,” and both calls batched 7–8
captures into the hangup window. The same sentence was then added to
`buildCallControlBlock` (stable prefix). **Do not delete those slugs from
call-control to look more like Vapi.**

What *should* look more like Vapi is the **persona**: describe the job
(“log this once if you have a logging tool”) the way 01/06/09 already do for
discount and CRM, not `` `crmSync` `` the way 07 does.

## Tool descriptions (load-bearing or not)

| Tool | Description carries when? | Notes |
|---|---|---|
| `hangUp` | Yes — after a spoken close, never silent, never mid-request | Matches ElevenLabs opt-in `end_call` + Bolna hang-up module. Always registered. |
| `transferToHuman` | Yes — after telling them, not silent; try to help first | Destination is **not** in the prompt (ADR-114). Good. Persona 06 still names the slug. |
| `captureField` | Yes — immediately; prohibited keys; `heard` required | Duplicated into call-control for a reason (above). Six hits in 09 is the opposite of capability language. |
| `crmSync` | Yes — once you have context; do not tell the caller it synced if `synced: false` | Withheld without creds (ADR-122). 07 still orders it by name. |
| `lookupInfo` | Yes — never guess; say you don’t have it | Returns `chunkText[]`. Pipecat rule: results must be speakable. Chunks can still be markdown; ADR-106 is the spoken-output guard, not a KB sanitizer. |
| `sendSms` | Yes — after telling them, only if they agreed | Body is model-authored; number is server-bound. |
| `bookAppointment` | Weak — “once you’ve confirmed a date/time and the caller’s name” | No “if this tool is absent, book nothing / take a message.” 06/09 name the slug anyway. |
| `confirmCodOrder` | (in schema; not re-read here) | Runtime 02 never names it — the better pattern. |

Filler: one canned line after 400ms for slow tools (`lookupInfo`, calendar,
CRM, Shopify). Operators cannot set “say this while CRM runs” per agent.
That is gap #4 in the parent note, confirmed.

## What the 2026-09-05 live calls already proved

Do not treat this scorecard as theoretical:

1. **Appointment-setter (`06`)** — runtime orders `transferToHuman` and
   audits “You’re connected.” Call-control forbids announcing a completed
   bridge. Org had no transfer number. Competitor analogue: Retell per-state
   tools + Vapi load-bearing `transferCall` description. We have the
   description and the withhold; the **persona close-set fights both**.
2. **Post-sale (`07`)** — runtime orders `crmSync`; close-set has no
   documents-not-received line; model hung up empty; ADR-124 stopped the
   hearing apology but not the missing close. Competitor analogue: Bolna
   Closing Branches module. We compose hangUp, not closings.

Shopify `01` is the internal gold standard for a gated tool. Insurance `04`
is the gold standard for *not* naming CRM/transfer in the persona. `07` is
the worst of the nine against this checklist.

## What not to do next

- Do not paste a Vapi six-section template over these files. They already
  section. The defect is honesty and missing closes, not missing headings.
- Do not move compliance into `# Guardrails` and call it done.
- Do not add a never-say list to “fix” “You’re connected” — delete/replace
  the audited close (STOP-AND-ASK on personas).
- Do not flatten runtime markdown headings.
- Do not promote per-state tool graphs in this PR. The cheap wins, if a
  later session is allowed to edit personas: (1) `06` live-transfer close →
  connecting, not connected; (2) `07` drop `` `crmSync` ``, add a
  documents-not-received close in EN/HI/Hinglish; (3) `09` drop
  `captureField` / `transferToHuman` slugs the way `02` dropped
  `confirmCodOrder`.

## How to use this file

- Parent comparison (vendor docs) →
  [`competitor-agent-prompting-2026-09-05.md`](./competitor-agent-prompting-2026-09-05.md)
- Editing a persona → this scorecard’s per-agent table, then ADR-104 / 105 /
  106 / 122, then STOP-AND-ASK
- Re-run the counts: extract runtime via `extractRuntimePersona` the same way
  `packages/api/src/database/prompt-hygiene.test.ts` does — do not grep the
  whole markdown file
