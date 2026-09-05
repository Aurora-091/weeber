import z from "zod";
import { tool } from "ai";
import { syncToGoHighLevel } from "../integrations/gohighlevel";
import { syncToSalesforce } from "../integrations/salesforce";
import { syncToHubspot } from "../integrations/hubspot";
import { getOrgCrmCredentials } from "../integrations/resolve-crm";
import { db } from "../../database";
import { guardrailEvents } from "../../database/schema";

/**
 * Whose CRM record this call writes to — bound server-side at session
 * construction, never supplied by the model.
 *
 * G1.4 (ADR-069, 2026-08-01), applying ADR-066's rule to the last tool that
 * still violated it. See `createCrmSyncTool` for why this had to change.
 */
export type CrmSyncContext = {
  /** Which org's connected CRM to write to — same value `lookupInfo` is scoped by. */
  orgId: string;
  /**
   * The human's E.164 number on this call, from `resolveHumanNumber` — i.e.
   * `fromNumber` on inbound and `toNumber` on outbound. This is the *upsert
   * key* every provider adapter matches on, so it decides which contact
   * record gets written.
   */
  phoneNumber: string;
  /**
   * A4 (phase-a-integrity.md) — this call's `calls.id`, so an undelivered
   * sync (`synced: false`, whether "not configured" or a real provider
   * failure) can be recorded as a durable `guardrail_events` row instead of
   * only ever being visible in this call's live transcript. Two production
   * calls both returned `{"synced":false}` here and nothing downstream ever
   * noticed.
   */
  callId: number;
};

/**
 * Logs the call to the org's connected CRM, creating or updating the caller's
 * contact record.
 *
 * ---
 *
 * **Why this is a bound factory (G1.4 / ADR-069, 2026-08-01).** The tool used
 * to take `phoneNumber: z.string()` as a *required, model-authored input*
 * while that same value is the upsert key: `syncToGoHighLevel` POSTs
 * `{ phone: phoneNumber }` to LeadConnector's `/contacts/upsert`
 * (`../integrations/gohighlevel.ts:23-32`), and the Salesforce/HubSpot
 * adapters match on it the same way. "Upsert" is the whole problem — a wrong
 * number does not fail, it silently *matches a different existing contact*
 * and appends this call's notes to that person's timeline, or invents a new
 * junk contact when it matches nothing.
 *
 * Three ways the model could get it wrong, none of them exotic:
 *
 *  1. **Hallucination.** Nothing in the prompt reliably carried the caller's
 *     number — the persona merge tags were never rendered (see ADR-065) — so
 *     on most calls the model's only route to filling a required string field
 *     was to invent a plausible one.
 *  2. **Mistranscription.** When the caller *does* read a number aloud, STT
 *     digit errors are routine, especially over Indian PSTN with accented
 *     Hinglish digits. One wrong digit is a different contact.
 *  3. **Injection.** A caller can simply say "log this under +1555…" and the
 *     model has no reason to refuse — the field was documented as theirs to
 *     fill. `voice/injection-detection.ts` is log-only, so nothing stops it.
 *
 * The correct number is already known server-side before the first turn:
 * `stream.ts`'s `"start"` handler computes
 * `resolveHumanNumber(row.direction, row.fromNumber, row.toNumber)` from the
 * telephony provider's own call record (`voice/stream.ts:1561`). The carrier
 * knows who is on the line; the model does not. So the number is closed over
 * here and the model's input narrows to the two fields it genuinely is the
 * author of: the name it heard, and a summary of what the call was about.
 *
 * The gate is **non-registration**, not validation — same contract as
        * `confirmCodOrder` (ADR-064/066): `resolveCrmSyncContext` returns `undefined`
 * when there's no org or no resolvable human number, and `resolveLiveCrmSyncContext`
 * additionally withholds the tool when the org has no connected CRM (ADR-122).
 * `buildVoiceTools` then omits the tool entirely for that call. A tool that isn't in the request
 * cannot be called with a guessed argument.
 *
 * Deliberate consequence: the text test-chat, the synthetic AI-to-AI harness,
 * and the preview drawer no longer get this tool at all, because none of them
 * has a real human on a real number. Before this change all three could write
 * live contact records into a merchant's production CRM from a test — the same
 * class of side effect that kept `offerCartRecoveryDiscount` out of them.
 */
export function createCrmSyncTool(ctx: CrmSyncContext) {
  const { orgId, phoneNumber, callId } = ctx;

  /**
   * A4: an undelivered sync is recorded as a durable, queryable row the
   * moment it happens — not left as something only visible in this call's
   * live transcript, which is how it went unnoticed on two production calls.
   * Fire-and-forget, same contract as every other guardrail-event insert in
   * this codebase (stream.ts's logToolCall): a logging failure here must
   * never surface as a tool error to the model or the caller.
   */
  function recordIfUndelivered(result: { synced?: boolean; message?: string }) {
    if (result.synced !== false) return;
    void db
      .insert(guardrailEvents)
      .values({
        callId,
        orgId,
        category: "undelivered-outcome",
        source: "crm-sync",
        detail: result.message ?? "crmSync returned synced: false",
      })
      .catch((err) => console.error("[voice] failed to log undelivered crmSync outcome", err));
  }

  return tool({
    description:
      "Log this call to the CRM and create or update the caller's contact record. Use this once you have " +
      "enough context to be worth recording — not on every turn. You do not identify the caller's phone " +
      "number: this call is already tied to the correct contact. If the result says synced: false, the " +
      "record was NOT delivered — never tell the caller it was logged/saved/synced when it wasn't.",
    inputSchema: z.object({
      callerName: z.string().optional(),
      notes: z.string().describe("Brief summary of what this call was about"),
    }),
    async execute({ callerName, notes }) {
      const crmConfig = await getOrgCrmCredentials(orgId);
      if (!crmConfig) {
        const result = {
          crm: null,
          synced: false as const,
          message: "(not configured) No CRM connected for this organization. Connect one in Settings > Integrations.",
        };
        recordIfUndelivered(result);
        return result;
      }

      const { provider, credentials } = crmConfig;
      switch (provider) {
        case "gohighlevel": {
          const syncResult = await syncToGoHighLevel(phoneNumber, callerName, notes, credentials.api_key, credentials.location_id);
          const result = { crm: "gohighlevel", ...syncResult };
          recordIfUndelivered(result);
          return result;
        }
        case "salesforce": {
          const syncResult = await syncToSalesforce(phoneNumber, callerName, notes, credentials.access_token, credentials.instance_url);
          const result = { crm: "salesforce", ...syncResult };
          recordIfUndelivered(result);
          return result;
        }
        case "hubspot": {
          const syncResult = await syncToHubspot(phoneNumber, callerName, notes, credentials.api_key);
          const result = { crm: "hubspot", ...syncResult };
          recordIfUndelivered(result);
          return result;
        }
      }
    },
  });
}

/**
 * Derives the bound CRM-write context for a call, or `undefined` when this
 * call has no org or no resolvable human number — in which case
 * `buildVoiceTools` does not register the tool at all.
 *
 * `humanNumber` comes from `caller-memory.ts`'s `resolveHumanNumber`, which
 * already picks the correct leg by direction. The only checks applied here are
 * "is there actually a value" and a minimal shape check: a CRM upsert key must
 * look like a phone number, and a placeholder like `"unknown"`, `"anonymous"`,
 * or an empty string arriving from a provider that withheld caller ID would
 * otherwise become a real contact record keyed on garbage.
 *
 * The shape check is deliberately loose (digits, optional leading `+`, 7-15
 * digits per E.164) rather than a full parse — this is a "did we get a number
 * at all" guard, not number validation. The number's *authority* comes from it
 * being the carrier's, not from it passing a regex.
 *
 * A4: also gated on `callId` now — no call row yet means nowhere to attach an
 * undelivered-sync guardrail row, so the tool is omitted rather than offered
 * without the ability to record its own failure. In practice this is never
 * the live-call path's actual behaviour (the call row is inserted before any
 * tool could fire); it only ever bites the same non-live surfaces the org/
 * number checks above already exclude.
 */
export function resolveCrmSyncContext(input: {
  orgId?: string;
  humanNumber?: string;
  callId?: number | null;
}): CrmSyncContext | undefined {
  const orgId = input.orgId?.trim();
  if (!orgId) return undefined;

  const raw = input.humanNumber?.trim();
  if (!raw) return undefined;
  if (!/^\+?[0-9]{7,15}$/.test(raw.replace(/[\s()\-.]/g, ""))) return undefined;

  if (!input.callId) return undefined;

  return { orgId, phoneNumber: raw, callId: input.callId };
}

/**
 * ADR-122: the live-call gate is "can this write actually land", not only
 * "do we know whose record it would be". `resolveCrmSyncContext` still
 * binds org + carrier number + callId; this second check withholds the
 * tool when the org has no connected CRM, so the model cannot spend a
 * turn (and the 2.5s first-token budget) on a guaranteed `synced: false`.
 *
 * Same non-registration contract as `confirmCodOrder` (ADR-064). Credential
 * lookup is best-effort — a vault/DB failure omits the tool rather than
 * offering a write that will fail mid-turn.
 */
export async function resolveLiveCrmSyncContext(input: {
  orgId?: string;
  humanNumber?: string;
  callId?: number | null;
}): Promise<CrmSyncContext | undefined> {
  const ctx = resolveCrmSyncContext(input);
  if (!ctx) return undefined;
  try {
    const creds = await getOrgCrmCredentials(ctx.orgId);
    if (!creds) {
      console.log(`[voice] crmSync withheld — no CRM credentials for org ${ctx.orgId}`);
      return undefined;
    }
    return ctx;
  } catch (err) {
    console.warn("[voice] crmSync withheld — credential lookup failed", { orgId: ctx.orgId, err });
    return undefined;
  }
}
