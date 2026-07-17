# LLM provider case study — reducing TTFT without changing model quality tier

**Date:** 2026-07-17
**Trigger:** pickup-to-first-word latency investigation (see `audit/2026-07-10-audit-01.md` D7, and this session's `pickupToFirstAudioMs` instrumentation). Real production data showed LLM time-to-first-token is the single biggest chunk of the pipeline — ~1000-1600ms out of a ~1.7-2.1s total. This doc is the "what are our actual options" study before touching the default model/provider.

## Current setup, measured

| Stage | Real production value (calls 11-14, 2026-07-17) |
|---|---|
| STT connect | 544-573ms (runs concurrently, not on critical path) |
| **LLM time-to-first-token** | **1030-1567ms** |
| TTS first byte (incremental, after LLM starts streaming) | +343-470ms |

Active config: `LLM_PROVIDER=gateway`, `AI_GATEWAY_MODEL=google/gemini-3.1-flash-lite`, routed through Vercel's AI Gateway (`gateway.ts`). `GROQ_API_KEY` is already set and `llm/index.ts` already has a fully-wired `groq` provider option (per-agent override, `resolveLlmProvider`) — this was built specifically as "the highest-leverage latency lever available" per that file's own doc comment, just never made the default.

## Is the Gateway itself the problem?

**No — checked this specifically, and it's not the bottleneck.** Vercel's AI Gateway adds roughly 15-25ms of routing overhead on top of whatever the underlying provider takes — and in some published benchmarks, Gateway requests actually came out *faster* than going direct (its own docs claim smart provider routing by recent latency/uptime; one third-party benchmark measured Gateway ~25% faster than direct OpenAI on the same model, another measured Anthropic through Gateway ~15% faster on tail latency despite ~200ms average overhead). The overhead is small and sometimes negative. **The real lever is which underlying model/provider serves the tokens, not whether you go through Gateway to get there.**

Switching from Gateway-routed Gemini to *direct* Gemini API calls would not meaningfully help — you'd lose Gateway's automatic failover/observability for a rounding-error latency change, and one provider benchmark (Artificial Analysis) actually showed direct Google AI Studio's own TTFT for this exact model was *higher* than typical Gateway-routed figures, not lower. Not a productive direction.

## Where the real gap is: which model/provider serves the tokens

This is fundamentally a hardware story. Gemini/GPT-class models run on general-purpose GPU clusters with request queuing; Groq/Cerebras/SambaNova run on purpose-built inference silicon (LPU / wafer-scale / reconfigurable dataflow chips) that process a request's full context in parallel instead of token-by-token GPU passes — that's *why* their TTFT is categorically lower, not just "a faster cloud region."

| Provider | Hardware | Typical TTFT (published) | Typical throughput | Models available | Quality tier vs current Gemini Flash-Lite | Integration effort here |
|---|---|---|---|---|---|---|
| **Groq** (already wired) | LPU | ~200-400ms | ~300-750 tok/s (model-dependent) | Llama 3.x, Kimi, Qwen, gpt-oss | Comparable conversational quality, different house style — needs a real side-by-side, not assumed equivalent | **Zero — flip `LLM_PROVIDER=groq` or set per-agent** |
| **Cerebras** | Wafer-scale | ~45-240ms (as low as 45-60ms cited for Llama 2 70B batch, 240ms for Llama 3.1 405B) | 450-2,600+ tok/s depending on model | Llama 3.1/3.3/4 family, gpt-oss-120B | Can run the *largest* Llama models (405B) at speeds Groq can't match for that size — highest quality-per-ms in this comparison | **Small — OpenAI-compatible endpoint, same shape as adding Groq (new `createOpenAI({baseURL: 'https://api.cerebras.ai/v1'})` provider, mirrors `llm/index.ts`'s existing pattern)** |
| **SambaNova** | RDU (dataflow) | Competitive with Cerebras on some models (~435 tok/s cited) | High | Llama family, DeepSeek | Similar tier to Groq/Cerebras | Small — also OpenAI-compatible |
| **Fireworks / Together / DeepInfra** | GPU, but optimized serving | Slower than the three above, still faster than typical unoptimized GPU serving | Moderate-high | Widest model selection (open + some closed) | Flexible — can match almost any quality tier you want | Small — all OpenAI-compatible, `ai-sdk` community providers exist for several |
| **Direct Gemini/OpenAI (bypassing Gateway)** | Standard cloud GPU | ~1-1.6s+ (matches what we're already seeing) | N/A | Same models already in use | Unchanged — same model | Not worth it — see above |

## What this means concretely for this platform

1. **Groq is the free move.** It's built, tested, and just needs a config flip. Real risk is conversational *style* difference (Llama 3.3 70B vs Gemini Flash-Lite), not latency — worth an actual side-by-side test call before flipping the platform default, exactly as discussed.
2. **Cerebras is the highest-ceiling move if you want to add a provider.** It's the only option here that gets you *both* a huge quality tier (Llama 3.1 405B-class, likely closer to or above current Gemini quality than Groq's 70B) *and* Groq-or-better latency (240ms TTFT at that size, per Cerebras's own published numbers — take vendor-published latency numbers as directionally right, not gospel, until measured on our own real traffic). This is the one worth actually building if the Groq A/B doesn't land right on quality.
3. **The AI Gateway's own multi-model failover (already built this session, `buildGatewayProviderOptions`) only helps within Gateway-routed models** — it doesn't apply to Groq today (noted in that file's own doc comment). If Cerebras/SambaNova get added as real options, they'd need their own place in the existing `resolveLlmProvider`-style registry (mirroring how Groq was added), not the Gateway's fallback array.
4. **Realistic target:** shaving LLM TTFT from ~1.0-1.6s down to Groq/Cerebras's ~200-400ms range would bring total pickup-to-first-word from today's measured ~1.7-2.1s pipeline time down to roughly **~1.0-1.3s** — a substantial, directly-felt improvement on every single turn, not just the greeting.

## Recommended next step

Don't flip the platform default yet — same reasoning as before (model swap changes conversational behavior, not just speed). Two low-risk ways to actually test this with real data instead of vendor benchmarks:

- **Fastest to try:** set `llmProvider: "groq"` on your test agent specifically (already supported, per-agent override) and run a couple of test calls — same instrumentation from this session will show the real TTFT immediately, and you can judge the conversational quality yourself.
- **If Groq's style doesn't feel right:** worth building the Cerebras provider option next (small, mechanical addition mirroring the Groq pattern) — it's the one candidate here that doesn't ask you to trade quality for speed.

Say which one you want and I'll build/wire it.
