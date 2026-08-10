# ADR-094 — A sentence with a hole in it is not a safer sentence

**Date:** 2026-08-10
**Status:** Proposed
**Supersedes the reasoning in:** `merge-tags.ts` (G1.3, 2026-08-01) — the delete-don't-substitute rule stands; the assumption about what the model then does with the result does not.
**Evidence:** audit 14 §3, audit 13 §2.

---

## Context

G1.3 fixed a real bug: a cart-recovery persona said `"calling on behalf of {{merchant_name}}"` and nothing rendered it, so the agent could read a merge tag aloud to a customer. `merge-tags.ts` fixed it by **stripping** every unresolved `{{tag}}` from the composed system prompt.

That module's reasoning against the two obvious alternatives is sound and should be preserved verbatim:

- **Don't render the persona.** The tag vocabularies don't match (`MERGE_TAGS` says `shop_name`/`cart_value`; the prompt docs say `merchant_name`/`cart_total`), and some tags — `cart_items_summary` — have no producer anywhere in the codebase, so rendering could never resolve them.
- **Don't substitute a placeholder or a default.** A placeholder is still speakable, and a guessed default ("our store") is a false statement in the model's most trusted channel.

It then made one further claim, and this is the one production has now falsified:

> *"Deleting the hole degrades the sentence to a slightly vaguer instruction ("calling on behalf of ."), which the model handles gracefully, and leaves the real value to arrive through a facts block if it's known."*

## What actually happens

The insurance templates put their opener in the persona body as an instruction containing four tags. When the lead row has no name — which is **every lead row in production** — the deterministic render path in `stream.ts:2150` rejects the line and falls back to the LLM, which then reads the *scrubbed* opener:

```
Hi, is this ? This is with presistentads — you'd recently reached out about, and I wanted to follow up.
```

Three of the four calls placed on 2026-08-10 spoke the damage in their first sentence:

| call | first sentence, verbatim from `transcripts` |
|---|---|
| 22 | "Hello, is this **?** This is calling on behalf of krisn" |
| 24 | "Hi, is this **[Caller Name]**? This is **[Agent Name]** with presistentads" |
| 25 | "Hi, is this **[Caller Name]**? This is **[Agent Name]** with presistentads" |

`[Caller Name]` exists nowhere in the repo or the database. The model wrote it. That is the predictable behaviour of a next-token predictor handed a grammatical slot: it fills it. Deleting a hole does not remove the hole — it removes the *label* on the hole, which makes the model's guess less constrained, not more. The same failure reached SMS: call 25 sent a message body containing `[Advisor Desk Number]` (audit 14 §5, F5).

Two mitigations that are each individually defensible compose into a worse outcome than either alone: the render path bails out precisely on the calls where data is missing, and hands the LLM path a mutilated instruction on exactly those calls.

## Decision

**An instruction the runtime cannot complete must not be sent. It is replaced by a different, complete instruction — never by a damaged copy of itself.**

Concretely:

1. **Keep `stripUnresolvedMergeTags` as the last-line-of-defence scrub.** It stays exactly as it is, including the warning. It is the net, not the plan.
2. **Every tag-bearing spoken line gets an authored tagless alternate.** A greeting that needs `{{lead_name}}` gets a sibling line that needs nothing — *"Hi, this is Alice with PersistentAds — am I speaking with the account holder?"* — which is a complete, honest, audited sentence and is what gets used when the name is unknown. Not a fallback to the LLM.
3. **The unresolvable case stops being a silent LLM fallback.** Today one missing tag costs ~1.5 s of LLM time-to-first-token *and* risks a spoken placeholder, and logs nothing. It must log which tag was missing, and it must select the alternate line rather than re-deriving the sentence through the model.
4. **Tags are only permitted where a producer exists.** A template may not reference a tag with no writer in the codebase (`cart_items_summary`, `interest_area` on an intake that never collects it). Enforce it at seed/save time, not at 3 a.m. on a live call.

The invariant `merge-tags.ts` already states — *prompts supply instructions, blocks supply values* — is right. This ADR adds the missing half: **an instruction is atomic.** A value can be absent; a sentence cannot be partial.

## Consequences

**Good.**
- The agent can no longer speak or SMS a placeholder it invented, on any path.
- Fixes audit 13's P0 latency finding as a side effect. The literal-greeting fast path is currently **0 for 11** in production — every call, ids 15–25, paid LLM time-to-first-token for a deterministic line, p50 1539 ms, on the metric the callee most directly feels (`pickup_to_first_audio`, median 2037 ms). One change, two P0s.
- Makes an authoring mistake fail at seed time instead of on a call.

**Costs.**
- Every template now needs a second authored, and for insurance re-audited, opening line per language. That is real compliance work, not a code change.
- The tagless alternate is a slightly worse conversation opener — it cannot use the caller's name. That is the correct trade: a generic greeting is worse than a personalised one and infinitely better than `[Caller Name]`.
- A producer-existence check on tags will fail some templates on first run. That is the finding, not a regression.

**Explicitly not decided here.** Whether to fix the underlying data problem — leads with no `name` and no `interest_area` — by making those fields required at intake. That is a product decision about lead-list quality and it does not block this ADR; the alternate line is needed regardless, because there will always be leads with missing fields.

## Alternatives rejected

- **Substitute a placeholder or a default.** Already rejected by G1.3, still rejected, for its original reasons.
- **Let the LLM improvise the greeting deliberately.** This is the status quo and it produced `[Caller Name]` three times in one day. It also forfeits the audited-wording guarantee the insurance templates exist to provide, and costs ~1.5 s.
- **Instruct the persona harder** ("never speak a placeholder"). `DEFAULT_PERSONA` already tells the model not to emit markdown or symbols, and call 25 spoke `*Sending text message...*` and `[[tone:upbeat]]` anyway (audit 14 §5, F3). A prompt instruction is not an enforcement mechanism.
- **Post-filter the model's speech for `[...]` patterns.** Worth doing at the TTS boundary for other reasons (F3), but as the fix here it treats the symptom and cannot distinguish an invented slot marker from a legitimately spoken bracket. It also still pays the LLM latency.
