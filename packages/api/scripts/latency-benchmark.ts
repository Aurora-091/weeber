#!/usr/bin/env bun
/**
 * Synthetic latency benchmark (§2b) — measures the same three stages
 * stream.ts instruments per-turn in production (see turnLatency in
 * schema.ts and speak()'s persistTurnLatency): STT connect time, LLM
 * time-to-first-token, and TTS time-to-first-audio-byte. Run it standalone,
 * with no live call/Twilio/DB required, to get a quick read on "how fast is
 * the pipeline right now" against whichever providers have credentials
 * configured in the environment — useful for A/B-ing a provider swap or a
 * model change before it ever touches a real call.
 *
 * Usage:
 *   bun run bench:latency
 *   bun run bench:latency --iterations=10
 *   bun run bench:latency --iterations=3 --stages=llm,tts
 *
 * A stage with no API key configured is reported as "not configured —
 * skipped" rather than silently omitted or faked with a 0 — matching the
 * "no fabricated metrics" rule the rest of the latency/analytics code
 * follows (see org-queries.ts's computeOrgAnalytics doc comment).
 */
import { connectStt, resolveSttProvider } from "../src/voice/stt";
import { connectTts, resolveTtsProvider } from "../src/voice/tts";
import { runVoiceAgentTurn } from "../src/voice/agent";
import { resolveLlmProvider, getActiveModelLabel } from "../src/voice/llm";

export type StageResult = {
  stage: string;
  provider: string;
  configured: boolean;
  skipReason?: string;
  samples: number[];
};

export type StageStats = {
  stage: string;
  provider: string;
  configured: boolean;
  skipReason?: string;
  sampleCount: number;
  p50: number | null;
  p90: number | null;
  avg: number | null;
};

/**
 * Nearest-rank percentile — same method as org-queries.ts's percentile()
 * (kept as a separate small copy here rather than imported, since that
 * module pulls in the real `db` connection via ../database, which this
 * standalone script has no DATABASE_URL for and doesn't need).
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)] ?? null;
}

/**
 * A rejection can be a real Error (most providers), a browser-style
 * ErrorEvent (WebSocket-based providers like Cartesia/Deepgram, whose
 * `.message` isn't picked up by `String()` — that just gives the useless
 * "[object ErrorEvent]"), or a bare string. Normalizes all three into a
 * readable skip reason.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return err === undefined ? "no successful iterations" : String(err);
}

export function computeStats(result: StageResult): StageStats {
  const avg = result.samples.length === 0 ? null : result.samples.reduce((a, b) => a + b, 0) / result.samples.length;
  return {
    stage: result.stage,
    provider: result.provider,
    configured: result.configured,
    skipReason: result.skipReason,
    sampleCount: result.samples.length,
    p50: percentile(result.samples, 50),
    p90: percentile(result.samples, 90),
    avg: avg === null ? null : Math.round(avg),
  };
}

/**
 * Runs `measureOnce` up to `iterations` times, collecting successful
 * latency samples. A single iteration throwing (e.g. a transient network
 * blip) doesn't abort the whole stage — only every iteration failing with
 * the *same* "not configured" style error does, at which point the stage
 * is reported as unconfigured rather than as a pile of 0ms samples.
 */
export async function runStage(
  stage: string,
  provider: string,
  iterations: number,
  measureOnce: () => Promise<number>,
): Promise<StageResult> {
  const samples: number[] = [];
  let lastError: unknown;
  for (let i = 0; i < iterations; i++) {
    try {
      samples.push(await measureOnce());
    } catch (err) {
      lastError = err;
    }
  }
  if (samples.length === 0) {
    return {
      stage,
      provider,
      configured: false,
      skipReason: describeError(lastError),
      samples: [],
    };
  }
  return { stage, provider, configured: true, samples };
}

/** STT: time from opening the provider connection to its own "connected" callback (onConnected). */
function measureSttConnect(): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("STT connect timed out after 8s")), 8000);
    const conn = connectStt(
      () => undefined,
      (err) => {
        clearTimeout(timeout);
        reject(new Error(describeError(err)));
      },
      undefined,
      (ms) => {
        clearTimeout(timeout);
        conn.close();
        resolve(ms);
      },
    );
  });
}

/** LLM: time-to-first-token for a short, fixed, tool-free turn — same code path stream.ts's runTurn uses. */
async function measureLlmTtft(): Promise<number> {
  let ttft: number | null = null;
  await runVoiceAgentTurn({
    history: [{ role: "user", content: "Hi, quick question — what are your hours?" }],
    onTextDelta: () => undefined,
    enabledTools: [],
    onLatency: (ms) => {
      ttft = ms;
    },
  });
  if (ttft === null) throw new Error("LLM turn completed with no measurable first token");
  return ttft;
}

/** TTS: time from sending text to the first audio chunk coming back. */
function measureTtsFirstByte(): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("TTS first byte timed out after 8s")), 8000);
    const sentAt = Date.now();
    const conn = connectTts(
      () => {
        clearTimeout(timeout);
        conn.close();
        resolve(Date.now() - sentAt);
      },
      undefined,
      (err) => {
        clearTimeout(timeout);
        reject(new Error(describeError(err)));
      },
    );
    conn.sendText("This is a quick latency benchmark test sentence.");
    conn.endTurn();
  });
}

function parseArgs(argv: string[]) {
  const iterationsArg = argv.find((a) => a.startsWith("--iterations="));
  const stagesArg = argv.find((a) => a.startsWith("--stages="));
  return {
    iterations: iterationsArg ? Math.max(1, Number(iterationsArg.split("=")[1]) || 5) : 5,
    stages: stagesArg ? stagesArg.split("=")[1].split(",").map((s) => s.trim().toLowerCase()) : ["stt", "llm", "tts"],
  };
}

function formatMs(ms: number | null): string {
  return ms === null ? "—" : `${ms}ms`;
}

function printStage(stats: StageStats) {
  console.log(`\n--- ${stats.stage} (${stats.provider}) ---`);
  if (!stats.configured) {
    console.log(`  not configured — skipped (${stats.skipReason})`);
    return;
  }
  console.log(`  samples: ${stats.sampleCount}`);
  console.log(`  P50: ${formatMs(stats.p50)}  P90: ${formatMs(stats.p90)}  avg: ${formatMs(stats.avg)}`);
}

async function main() {
  const { iterations, stages } = parseArgs(process.argv.slice(2));
  console.log("=== Weeber Voice Pipeline Latency Benchmark ===");
  console.log(`Iterations per stage: ${iterations}`);
  console.log(`Stages: ${stages.join(", ")}`);

  const results: StageStats[] = [];

  if (stages.includes("stt")) {
    const provider = resolveSttProvider();
    results.push(computeStats(await runStage("STT connect", provider, iterations, measureSttConnect)));
  }

  if (stages.includes("llm")) {
    const provider = getActiveModelLabel(resolveLlmProvider());
    results.push(computeStats(await runStage("LLM time-to-first-token", provider, iterations, measureLlmTtft)));
  }

  if (stages.includes("tts")) {
    const provider = resolveTtsProvider();
    results.push(computeStats(await runStage("TTS first audio byte", provider, iterations, measureTtsFirstByte)));
  }

  for (const stats of results) printStage(stats);

  const llm = results.find((r) => r.stage === "LLM time-to-first-token");
  const tts = results.find((r) => r.stage === "TTS first audio byte");
  console.log("\n--- Estimated voice-to-voice (LLM TTFT + TTS first byte, P50) ---");
  if (llm?.configured && tts?.configured && llm.p50 !== null && tts.p50 !== null) {
    console.log(`  ~${llm.p50 + tts.p50}ms (this doesn't include STT connect, which is a one-time per-call cost,`);
    console.log("  not a per-turn one — see turnLatency's schema doc comment for why voiceToVoiceMs excludes it)");
  } else {
    console.log("  not enough data — need both LLM and TTS stages configured and successful");
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[latency-benchmark] fatal error", err);
    process.exit(1);
  });
}
