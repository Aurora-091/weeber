// Example/stub Supabase Edge Function — NOT yet wired to the Railway
// backend's /customers/redact route (see
// packages/web/src/api/integrations/shopify/routes.ts). Intended use:
// low-frequency async jobs that don't need to live on the hot path of the
// main Bun server (e.g. notifying ops that a GDPR erasure ran, so it's
// auditable outside the app's own logs).
//
// To actually wire this in: have the backend's /customers/redact handler
// call `fetch(`${SUPABASE_URL}/functions/v1/gdpr-redact-notify`, ...)`
// after a successful redact. Not done in this scaffold — flagged in
// WEEBER-PLAN.md as a small, clearly-scoped follow-up, not a hidden gap.

Deno.serve(async (req: Request) => {
  const { shop, e164Redacted } = await req.json().catch(() => ({ shop: null, e164Redacted: null }));

  console.log(`[gdpr-redact-notify] redaction ran for shop=${shop} contact=${e164Redacted ? "1 record" : "none"}`);

  // Real implementation would post to Slack/email/an internal audit log here.

  return new Response(JSON.stringify({ acknowledged: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
