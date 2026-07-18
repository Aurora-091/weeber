import { useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Phone,
  PhoneOutgoing,
  Mic,
  Webhook,
  Database,
  KeyRound,
  Terminal,
  Zap,
  AlertTriangle,
} from "lucide-react";
import { CodeBlock } from "../components/code-block";
import { usePageMeta } from "../lib/usePageMeta";

const sections = [
  { id: "overview", label: "Overview", icon: Zap },
  { id: "architecture", label: "Architecture", icon: Mic },
  { id: "env", label: "Environment Variables", icon: KeyRound },
  { id: "inbound", label: "Inbound Calls", icon: Phone },
  { id: "outbound", label: "Outbound Calls", icon: PhoneOutgoing },
  { id: "webhooks", label: "Webhooks (n8n / Zapier)", icon: Webhook },
  { id: "endpoints", label: "API Reference", icon: Terminal },
  { id: "database", label: "Database Schema", icon: Database },
  { id: "tools", label: "Agent Tools", icon: Zap },
  { id: "limitations", label: "Known Limitations", icon: AlertTriangle },
];

function DocsPage() {
  const [active, setActive] = useState("overview");

  // Fixed 2026-07-18 (UI audit) — this page never called usePageMeta, so its
  // title/description/canonical/og tags silently kept whatever the previously
  // visited page had set (or the index.html defaults) instead of describing
  // this page. Every other marketing page already does this; docs.tsx was
  // the one gap.
  usePageMeta({
    title: "Documentation",
    description: "Voice Agent Infra documentation — architecture, environment variables, inbound/outbound call flows, webhooks, API reference, database schema, and agent tools.",
    path: "/docs",
  });

  const scrollTo = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border sticky top-0 bg-background/95 backdrop-blur z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-3">
          <Link
            to="/"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back to home"
          >
            <ArrowLeft className="size-5" aria-hidden="true" />
          </Link>
          <h1 className="text-lg font-semibold">Voice Agent Infra — Documentation</h1>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-10 flex gap-10">
        {/* Sidebar */}
        <nav className="hidden md:block w-56 shrink-0 sticky top-20 self-start">
          <ul className="space-y-1">
            {sections.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => scrollTo(s.id)}
                  className={`w-full flex items-center gap-2 text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    active === s.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <s.icon className="size-4 shrink-0" />
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Content */}
        <main className="flex-1 min-w-0 space-y-16 pb-24">
          {/* Overview */}
          <section id="overview" className="scroll-mt-20">
            <h2 className="text-2xl font-bold mb-3">Overview</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              This is self-hosted orchestration, bring-your-own AI providers — your own code, database, and
              call logic, wired to Twilio (telephony), Deepgram (speech-to-text), an LLM (reasoning + tool
              use), and ElevenLabs (text-to-speech). Those provider calls stay real cloud APIs — no one
              self-hosts a phone network or frontier-model inference — but no managed voice-agent platform
              sits in the middle: every stage of the pipeline runs on code you own in this repo, and you
              pick which provider fills each slot.
            </p>
            <p className="text-muted-foreground leading-relaxed mb-4">
              It supports both directions: people can call your Twilio number and talk to the agent
              (inbound), or you can trigger the agent to call someone (outbound). Calls are recorded,
              transcribed turn-by-turn, and every event can be pushed to n8n, Zapier, or any webhook
              consumer in real time.
            </p>
            <div className="grid sm:grid-cols-2 gap-4 mt-6">
              <div className="border border-border rounded-lg p-4">
                <h3 className="font-semibold mb-1 text-sm">What's built-in</h3>
                <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                  <li>Real-time speech-to-text (Deepgram)</li>
                  <li>Streaming LLM agent with tool calling</li>
                  <li>Real-time text-to-speech (ElevenLabs)</li>
                  <li>Barge-in / interruption handling</li>
                  <li>Call recording + full transcript storage</li>
                  <li>Outgoing webhooks for automation tools</li>
                </ul>
              </div>
              <div className="border border-border rounded-lg p-4">
                <h3 className="font-semibold mb-1 text-sm">What's a stub (swap in your own)</h3>
                <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                  <li>Agent tools — <code>lookupInfo</code>, <code>bookAppointment</code></li>
                  <li>Agent persona / system prompt</li>
                  <li>Any dashboard UI (this is backend/API-first)</li>
                </ul>
              </div>
            </div>
          </section>

          {/* Architecture */}
          <section id="architecture" className="scroll-mt-20">
            <h2 className="text-2xl font-bold mb-3">Architecture</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Twilio streams raw call audio to our server over a WebSocket ("Media Stream"). We forward that
              audio to Deepgram for live transcription, feed finalized transcripts to the LLM agent, stream
              the agent's reply into ElevenLabs for speech synthesis, and pipe the resulting audio straight
              back into the same Twilio WebSocket — all in real time, in both directions, on one connection
              per call.
            </p>
            <CodeBlock
              lang="flow"
              code={`Inbound:  Caller -> Twilio number -> POST /api/voice/incoming (TwiML) -> wss connect
Outbound: POST /api/voice/calls/outbound -> Twilio places call -> same TwiML/stream flow

Twilio Media Stream (bidirectional WS, base64 mu-law 8kHz audio frames)
        |  caller audio chunks
        v
Deepgram Live STT  (nova-3, mulaw/8kHz, interim + final results)
        |  finalized transcript (speech_final)
        v
LLM Agent (AI Gateway, streamed, tool-calling)
        |  streamed text tokens
        v
ElevenLabs TTS  (stream-input WS, output_format=ulaw_8000 — no re-encoding)
        |  streamed audio chunks
        v
Twilio Media Stream  ->  caller hears the agent

Barge-in: if Deepgram detects new speech while the agent is talking,
we send Twilio a "clear" event and abort the in-flight LLM/TTS immediately.`}
            />
            <p className="text-muted-foreground leading-relaxed mt-4">
              This WebSocket bridge (<code>packages/api/src/voice/stream.ts</code>) only runs correctly
              under the real Bun server — not Vite's dev SSR module runner. It's wired directly into{" "}
              <code>server.ts</code> (see <code>voice/ws-route.ts</code>), so REST endpoints work in dev
              mode, but live call audio requires the production server (<code>bun run start</code>).
            </p>
          </section>

          {/* Env vars */}
          <section id="env" className="scroll-mt-20">
            <h2 className="text-2xl font-bold mb-3">Environment Variables</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Set these in the root <code>.env</code>. Check <code>GET /api/health</code> to confirm which
              are configured.
            </p>
            <CodeBlock
              lang=".env"
              code={`DEEPGRAM_API_KEY=            # Deepgram live STT
ELEVENLABS_API_KEY=          # ElevenLabs TTS
ELEVENLABS_VOICE_ID=         # Voice to use for the agent
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=         # e.g. +15551234567 — used as caller ID for outbound calls
PUBLIC_APP_URL=              # Public https URL Twilio can reach (wss derived automatically)
AI_GATEWAY_BASE_URL=         # AI Gateway (pre-configured by the platform)
AI_GATEWAY_API_KEY=
WEBHOOK_URL=                 # Optional default webhook target for n8n/Zapier/Make (see below)`}
            />
          </section>

          {/* Inbound */}
          <section id="inbound" className="scroll-mt-20">
            <h2 className="text-2xl font-bold mb-3">Inbound Calls</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              In your Twilio Console, set the phone number's <strong>"A call comes in"</strong> webhook to:
            </p>
            <CodeBlock code={`POST  {PUBLIC_APP_URL}/api/voice/incoming`} />
            <p className="text-muted-foreground leading-relaxed mt-4">
              Twilio hits this webhook on every inbound call. We respond with TwiML that opens a{" "}
              <code>&lt;Connect&gt;&lt;Stream&gt;</code> to our WebSocket, which starts the STT → agent →
              TTS loop immediately. The call, transcript, and recording are all persisted automatically.
            </p>
          </section>

          {/* Outbound */}
          <section id="outbound" className="scroll-mt-20">
            <h2 className="text-2xl font-bold mb-3">Outbound Calls</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Trigger a call programmatically — from curl, your own app, or an n8n/Zapier action step:
            </p>
            <CodeBlock
              lang="bash"
              code={`curl -X POST {PUBLIC_APP_URL}/api/voice/calls/outbound \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+15559876543",
    "persona": "You are a friendly scheduling assistant for Acme Dental.",
    "webhookUrl": "https://your-n8n-instance/webhook/abc123"
  }'`}
            />
            <p className="text-muted-foreground leading-relaxed mt-4 mb-2">Request body fields:</p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li><code>to</code> <span className="text-xs">(required)</span> — E.164 phone number to call</li>
              <li><code>persona</code> <span className="text-xs">(optional)</span> — overrides the agent's default system prompt for this call only</li>
              <li><code>webhookUrl</code> <span className="text-xs">(optional)</span> — overrides <code>WEBHOOK_URL</code> for this call only</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">Response:</p>
            <CodeBlock lang="json" code={`{ "callSid": "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "status": "queued" }`} />
          </section>

          {/* Webhooks */}
          <section id="webhooks" className="scroll-mt-20">
            <h2 className="text-2xl font-bold mb-3">Webhooks — n8n / Zapier / Make</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              The pipeline pushes call events to an external URL as they happen — point this at an n8n
              Webhook node, a Zapier "Catch Hook" trigger, or any endpoint that accepts JSON POSTs.
              Delivery is fire-and-forget: a slow or failing webhook target never blocks or breaks the call.
            </p>

            <h3 className="font-semibold text-base mt-6 mb-2">Configuring the target URL</h3>
            <p className="text-muted-foreground leading-relaxed mb-3">
              Two ways to set it, resolved in this order:
            </p>
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside mb-4">
              <li>
                <strong>Per-call override</strong> — pass <code>webhookUrl</code> in the body of{" "}
                <code>POST /api/voice/calls/outbound</code>. Useful when different call flows should notify
                different n8n workflows.
              </li>
              <li>
                <strong>Global default</strong> — set <code>WEBHOOK_URL</code> in <code>.env</code>. Used for
                every call (inbound or outbound) that doesn't specify its own override.
              </li>
            </ol>
            <p className="text-muted-foreground leading-relaxed mb-4">
              If neither is set, no webhook fires — nothing else changes.
            </p>

            <h3 className="font-semibold text-base mt-6 mb-2">Events fired</h3>
            <div className="space-y-3">
              {[
                ["call.started", "Fired the moment a call connects (inbound webhook hit, or outbound call answered)."],
                ["call.transcript", "Fired for every finalized transcript turn — both caller and agent lines, as they happen."],
                ["call.tool_call", "Fired whenever the agent invokes a tool mid-call (e.g. lookupInfo, bookAppointment)."],
                ["call.completed", "Fired when Twilio reports the call status as completed."],
                ["call.recording_ready", "Fired once Twilio's recording webhook delivers the final recording URL."],
              ].map(([name, desc]) => (
                <div key={name} className="border border-border rounded-lg p-3">
                  <code className="text-sm font-semibold">{name}</code>
                  <p className="text-sm text-muted-foreground mt-1">{desc}</p>
                </div>
              ))}
            </div>

            <h3 className="font-semibold text-base mt-6 mb-2">Payload shape</h3>
            <p className="text-muted-foreground leading-relaxed mb-3">
              Every event POSTs the same envelope — only <code>data</code> differs per event:
            </p>
            <CodeBlock
              lang="json"
              code={`{
  "event": "call.transcript",
  "timestamp": "2026-07-04T20:15:03.221Z",
  "data": {
    "callSid": "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "callId": 42,
    "role": "caller",
    "text": "Hi, I'd like to book an appointment for Tuesday."
  }
}`}
            />

            <h3 className="font-semibold text-base mt-6 mb-2">Testing your n8n/Zapier hook</h3>
            <p className="text-muted-foreground leading-relaxed mb-3">
              Fire a sample event without making a real call — grab your n8n/Zapier "test webhook" URL and:
            </p>
            <CodeBlock
              lang="bash"
              code={`curl -X POST {PUBLIC_APP_URL}/api/voice/webhooks/test \\
  -H "Content-Type: application/json" \\
  -d '{ "url": "https://your-n8n-instance/webhook-test/abc123" }'

# Or omit "url" to test against the WEBHOOK_URL env default:
curl -X POST {PUBLIC_APP_URL}/api/voice/webhooks/test`}
            />

            <h3 className="font-semibold text-base mt-6 mb-2">n8n setup (quick steps)</h3>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Add a <strong>Webhook</strong> trigger node, method POST, copy its production URL</li>
              <li>Set that URL as <code>WEBHOOK_URL</code> in <code>.env</code>, or pass it per-call as <code>webhookUrl</code></li>
              <li>Use a <strong>Switch</strong> node on <code>{"{{$json.event}}"}</code> to branch per event type</li>
              <li>Access call data at <code>{"{{$json.data}}"}</code></li>
            </ol>

            <h3 className="font-semibold text-base mt-6 mb-2">Zapier setup (quick steps)</h3>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Create a Zap with trigger <strong>Webhooks by Zapier → Catch Hook</strong></li>
              <li>Copy the custom webhook URL Zapier gives you into <code>WEBHOOK_URL</code></li>
              <li>Use a Filter step on <code>event</code> to only continue for events you care about</li>
            </ol>
          </section>

          {/* API reference */}
          <section id="endpoints" className="scroll-mt-20">
            <h2 className="text-2xl font-bold mb-3">API Reference</h2>
            <div className="space-y-4">
              {[
                ["GET", "/api/health", "Pipeline health + which env keys are configured"],
                ["POST", "/api/voice/incoming", "Twilio webhook — returns TwiML to start the media stream (set as Twilio's Voice URL)"],
                ["POST", "/api/voice/calls/outbound", "Trigger an outbound call. Body: { to, persona?, webhookUrl? }"],
                ["POST", "/api/voice/status-callback", "Twilio call-status webhook (internal — configured automatically on outbound calls)"],
                ["POST", "/api/voice/recording-status", "Twilio recording webhook (internal — configured automatically)"],
                ["POST", "/api/voice/webhooks/test", "Send a sample event to a webhook URL for testing. Body: { url? }"],
                ["GET", "/api/voice/calls", "List all calls with status, direction, recording URL"],
                ["GET", "/api/voice/calls/:id/transcript", "Full transcript for one call"],
                ["WS", "/api/voice/stream", "Twilio Media Stream connection (internal — set automatically via TwiML)"],
              ].map(([method, path, desc]) => (
                <div key={path} className="flex gap-4 border-b border-border pb-3">
                  <span
                    className={`shrink-0 w-14 text-center text-xs font-mono font-semibold rounded px-2 py-1 h-fit ${
                      method === "GET"
                        ? "bg-blue-500/10 text-blue-500"
                        : method === "WS"
                          ? "bg-purple-500/10 text-purple-500"
                          : "bg-green-500/10 text-green-500"
                    }`}
                  >
                    {method}
                  </span>
                  <div>
                    <code className="text-sm font-semibold">{path}</code>
                    <p className="text-sm text-muted-foreground mt-0.5">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Database */}
          <section id="database" className="scroll-mt-20">
            <h2 className="text-2xl font-bold mb-3">Database Schema</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Three tables in <code>packages/api/src/database/schema.ts</code>, backed by Turso (SQLite)
              via Drizzle ORM:
            </p>
            <CodeBlock
              lang="ts"
              code={`calls        // one row per call
  id, twilioCallSid, direction, fromNumber, toNumber,
  status, agentPersona, recordingUrl, webhookUrl,
  startedAt, endedAt

transcripts  // one row per finalized turn
  id, callId, role ("caller" | "agent"), text, createdAt

toolCalls    // one row per agent tool invocation
  id, callId, toolName, input (json), output (json), createdAt`}
            />
            <p className="text-muted-foreground leading-relaxed mt-4">
              Run <code>bun run db:studio</code> from <code>packages/web</code> to browse this data directly.
            </p>
          </section>

          {/* Tools */}
          <section id="tools" className="scroll-mt-20">
            <h2 className="text-2xl font-bold mb-3">Agent Tools</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Tools live in <code>packages/api/src/voice/tools/</code> and are registered in{" "}
              <code>voice/agent.ts</code>. Two stubs ship out of the box to prove the tool-calling path
              works end-to-end during a live call — replace their bodies with real integrations:
            </p>
            <ul className="text-sm text-muted-foreground space-y-2 list-disc list-inside mb-4">
              <li><code>lookupInfo</code> — answers factual questions (hours, pricing, etc). Wire to a real KB/CRM.</li>
              <li><code>bookAppointment</code> — books a caller in once name + time are confirmed. Wire to a real calendar.</li>
            </ul>
            <CodeBlock
              lang="ts"
              code={`export const myTool = tool({
  description: "What this tool does.",
  inputSchema: z.object({ input: z.string() }),
  async execute({ input }) {
    // your real logic here
    return { result: input };
  },
});

// then register it:
export const voiceTools = { lookupInfo, bookAppointment, myTool };`}
            />
            <p className="text-muted-foreground leading-relaxed mt-4">
              Every tool call is logged to the <code>toolCalls</code> table and fires a{" "}
              <code>call.tool_call</code> webhook automatically — no extra wiring needed.
            </p>
          </section>

          {/* Limitations */}
          <section id="limitations" className="scroll-mt-20">
            <h2 className="text-2xl font-bold mb-3">Known Limitations</h2>
            <ul className="text-sm text-muted-foreground space-y-2 list-disc list-inside">
              <li>
                The live call audio path (WebSocket bridge) only works under the production Bun server, not
                Vite's dev server — use <code>bun run start</code> to test real calls.
              </li>
              <li>
                Session state (persona, webhook override) is stored in-memory, keyed by Twilio CallSid — fine
                for a single instance, swap for Redis/DB if you scale to multiple server instances.
              </li>
              <li>
                Agent tools are stubs — wire real data sources before using this in production.
              </li>
              <li>No dashboard UI — this is an API/backend-first infra layer by design.</li>
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}

export default DocsPage;
