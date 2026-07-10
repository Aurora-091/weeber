/**
 * Outgoing webhook dispatch — fires call lifecycle events to an external
 * automation tool (n8n, Zapier, Make, etc). Fire-and-forget: never blocks or
 * fails the call flow if the webhook target is slow/down.
 *
 * Resolution order for the target URL: per-call override (passed when
 * triggering an outbound call, or stored on the call row) > WEBHOOK_URL env
 * var (global default) > no-op if neither is set.
 */
export type VoiceWebhookEvent =
  | "call.started"
  | "call.transcript"
  | "call.tool_call"
  | "call.completed"
  | "call.recording_ready"
  /** A retry chain (workflow "retry" action) gave up after maxRetries — see ADR-030's `onExhausted`. */
  | "call.retries_exhausted"
  /** Twilio's async AMD determined a machine answered — see routes.ts's /amd-status-callback. */
  | "call.voicemail_detected";

export function resolveWebhookUrl(perCallUrl?: string | null) {
  return perCallUrl || process.env.WEBHOOK_URL || null;
}

export async function dispatchWebhook(
  targetUrl: string | null | undefined,
  event: VoiceWebhookEvent,
  data: Record<string, unknown>,
) {
  if (!targetUrl) return;

  try {
    await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        data,
      }),
    });
  } catch (err) {
    console.error(`[webhook] failed to deliver ${event} to ${targetUrl}`, err);
  }
}
