import { db } from "./index";
import { agentTemplates, workflowTemplates, orgs, featureFlags } from "./schema";
import { eq } from "drizzle-orm";
import { join } from "path";
import { SHOPIFY_WORKFLOW_TEMPLATES } from "../voice/workflows/seed-graph";
import { validateLockedNodesEnforced } from "../voice/workflows/scaffold";
import { extractRuntimePersona } from "../voice/persona-source";
import { DEMO_ORG_ID, DEMO_WIDGET_FLAG_KEY } from "../voice/demo-widget-constants";

/** Optional `visibility`/`ownerOrgId` cover the real demo-call widget's `weeber-pitch-agent`
 * (2026-08-27) — every catalog template omits both and keeps the schema's own public/null
 * defaults; see schema.ts's `agentTemplates.visibility` doc comment for the bespoke-templates
 * feature this reuses. */
type AgentTemplateSeed = {
  key: string;
  name: string;
  vertical: string;
  description: string;
  fileName: string;
  literalGreetingTemplate?: string;
  defaultTools: string[];
  active: boolean;
  visibility?: "public" | "private";
  ownerOrgId?: string;
};

/**
 * Single source of truth for the seeded agent templates — exported (not
 * inlined in seedAgentTemplates) so seed.test.ts can assert every template's
 * `defaultTools` is actually a subset of `AVAILABLE_TOOL_NAMES` (agent-frame.ts)
 * without duplicating this list. Guards against a repeat of the
 * confirmCodOrder/offerCartRecoveryDiscount bug: both tools were listed here
 * and referenced in their script docs' own "Tools" table, but were never
 * added to AVAILABLE_TOOL_NAMES or agent.ts's buildVoiceTools map, so
 * buildVoiceTools silently filtered them out of every call's actual tool
 * list — the model was told (by its own persona) to call a tool it never
 * had, with zero error anywhere. That was only caught by reading a live
 * call's production log line by line, not by any test — this test exists so
 * the next tool addition fails CI instead of shipping silently broken.
 */
export const AGENT_TEMPLATES: AgentTemplateSeed[] = [
    {
      key: "shopify-cart-recovery",
      name: "Shopify Cart Recovery",
      vertical: "shopify",
      description: "Recovers abandoned checkouts by calling customers after they abandon their cart.",
      fileName: "01-cart-recovery-agent.md",
      literalGreetingTemplate: "Hi, this is {{agent_name}} calling from {{merchant_name}}. Do you have a quick minute?",
      // `lookupInfo` added 2026-08-01. All three Shopify agents talk to real
      // customers who ask real questions ("what's your return window?",
      // "when does this ship?") and, without KB access, the model's only
      // options were to refuse or to invent — and the personas explicitly
      // promise answers come from the merchant's knowledge base. The tool is
      // safe for orgs that have no KB configured: createLookupInfoTool
      // (tools/lookupInfo.ts) returns an explicit "no knowledge base is
      // configured" note rather than erroring, and its description forbids
      // guessing when nothing comes back.
      defaultTools: ["offerCartRecoveryDiscount", "lookupInfo", "captureField", "markFieldUnanswered", "setDisposition", "setIntent"],
      active: true,
    },
    {
      key: "shopify-cod-confirmation",
      name: "Shopify COD Confirmation",
      vertical: "shopify",
      description: "Confirms Cash on Delivery orders to reduce RTO (Return to Origin) rates.",
      fileName: "02-cod-confirmation-agent.md",
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling from {{merchant_name}}. Can I have two minutes of your time?",
      defaultTools: ["confirmCodOrder", "lookupInfo", "captureField", "markFieldUnanswered", "setDisposition", "setIntent"],
      active: true,
    },
    {
      key: "shopify-feedback",
      name: "Shopify Post-Delivery Feedback",
      vertical: "shopify",
      description: "Calls customers after order fulfillment to collect post-delivery feedback.",
      fileName: "03-feedback-agent.md",
      // `{{product_name}}` was removed here in G1.3 (2026-08-01). Nothing in the
      // codebase ever writes product_name, so renderTemplate always left the
      // literal tag in place and stream.ts's unresolved-tag guard always
      // rejected the line — meaning this agent's fast canned-greeting path
      // never fired once and every feedback call silently paid full LLM
      // time-to-first-token on its opening line. A seeded greeting tag with no
      // producer is an invisible permanent latency regression.
      literalGreetingTemplate: "Hi, this is {{agent_name}} from {{merchant_name}}. Your recent order was delivered — do you have a minute to share how it went?",
      defaultTools: ["lookupInfo", "captureField", "markFieldUnanswered", "setDisposition", "setIntent"],
      // Confirmed final by the user 2026-07-18 (was drafted without a Bolna reference sample,
      // unlike 01/02 — held inactive pending explicit confirmation per WEEBER-PLAN.md's
      // STOP-AND-ASK gate #4 / project-brief.md item 4). Flipping to active makes it selectable
      // by merchants and eligible for AI-draft (org-queries.ts:118, ai-draft.ts:78 both filter on
      // `active = true`) — takes effect on next boot's seed upsert.
      active: true,
    },
    {
      key: "insurance-policy-renewal",
      name: "Insurance Policy Renewal Reminder",
      vertical: "insurance",
      description: "Reminds policyholders of an upcoming renewal or premium due date and routes anything beyond a simple confirm/decline to a licensed agent.",
      fileName: "04-insurance-policy-renewal-agent.md",
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling on behalf of {{merchant_name}} — a quick reminder about your policy renewal. Do you have a moment?",
      // flagGuardrailEvent added 2026-07-16 during the India+US regulatory iteration — the script
      // now explicitly calls it on the new "replacement" refusal (see
      // docs/agent-prompts/00-insurance-regulatory-reference.md); would otherwise repeat the
      // confirmCodOrder/offerCartRecoveryDiscount silent-drop bug seed.test.ts guards against.
      defaultTools: ["captureField", "markFieldUnanswered", "setDisposition", "setIntent", "transferToHuman", "flagGuardrailEvent", "crmSync"],
      active: true,
    },
    {
      key: "insurance-lead-followup",
      name: "Insurance Lead Follow-Up",
      vertical: "insurance",
      description: "Follows up on a new inbound lead, qualifies interest, and books a callback with a licensed advisor.",
      fileName: "05-insurance-lead-followup-agent.md",
      // {{interest_area}} was removed here (2026-08-17): it came from the leads
      // row via getLeadGreetingContext, which returns {} when the lead is absent
      // or has no intake fields. 11/11 production calls had no lead row at call
      // time, so {{interest_area}} always left an unresolved tag and the fast
      // path never fired once. Replaced with a generic opener using only
      // {{agent_name}} and {{merchant_name}}, both guaranteed-resolvable (see
      // stream.ts's greetingContext: agent_name defaults to "our team", and
      // merchant_name is set from orgs.name when present — {{company_name}}
      // is the same value under an older alias; standardized on
      // {{merchant_name}} here so there's one canonical guaranteed tag, not
      // two (2026-08-20)).
      literalGreetingTemplate: "Hi, this is {{agent_name}} calling from {{merchant_name}} — I wanted to quickly follow up with you. Do you have a couple of minutes?",
      // flagGuardrailEvent added 2026-07-16 — same reasoning as insurance-policy-renewal above.
      defaultTools: ["captureField", "markFieldUnanswered", "bookAppointment", "setDisposition", "setIntent", "flagGuardrailEvent", "crmSync"],
      active: true,
    },
    {
      key: "insurance-appointment-setter",
      name: "Insurance Appointment Setter / Warm-Transfer Router",
      vertical: "insurance",
      description: "Confirms continued interest from an already-warm lead and live-transfers to a licensed advisor, or books a specific callback if no advisor is available.",
      fileName: "06-insurance-appointment-setter-agent.md",
      // {{lead_name}} and {{interest_area}} removed (2026-08-17): same
      // leads-row dependency as insurance-lead-followup above.
      literalGreetingTemplate: "Hi, this is {{agent_name}} with {{merchant_name}} — I wanted to connect you with one of our licensed advisors. Is now a good time?",
      defaultTools: ["captureField", "markFieldUnanswered", "transferToHuman", "bookAppointment", "flagGuardrailEvent", "setDisposition", "setIntent", "crmSync"],
      active: true,
    },
    {
      key: "insurance-post-sale-welcome",
      name: "Insurance Post-Sale Welcome / Delivery Confirmation",
      vertical: "insurance",
      description: "Welcomes a new policyholder after a policy is issued, confirms documents arrived, and routes any coverage/claims/change/cancel request to a licensed advisor.",
      fileName: "07-insurance-post-sale-welcome-agent.md",
      // {{policyholder_name}} removed (2026-08-17): same leads-row dependency.
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling on behalf of {{merchant_name}} — a quick welcome call now that your new policy is in place. Do you have a moment?",
      defaultTools: ["captureField", "markFieldUnanswered", "lookupInfo", "transferToHuman", "flagGuardrailEvent", "setDisposition", "setIntent", "crmSync"],
      active: true,
    },
    {
      key: "insurance-feedback-nps",
      name: "Insurance Post-Interaction Feedback / NPS",
      vertical: "insurance",
      description: "Collects a 1-5 satisfaction rating and one open comment after a servicing interaction or claim, routing any complaint to a licensed human without engaging on its merits.",
      fileName: "08-insurance-feedback-nps-agent.md",
      // {{interaction_type}} removed (2026-08-17): same leads-row dependency.
      literalGreetingTemplate: "Hi, this is {{agent_name}} from {{merchant_name}}. I'm following up on a recent interaction — do you have a minute to share how it went?",
      defaultTools: ["captureField", "markFieldUnanswered", "flagGuardrailEvent", "transferToHuman", "setDisposition", "setIntent", "crmSync"],
      active: true,
    },
    {
      key: "insurance-final-expense-qualifier",
      name: "Insurance Final Expense Qualifier / Warm-Transfer",
      vertical: "insurance",
      description: "Qualifies a warm final-expense lead (need, service preference, cost context, rough budget, benefit timing, tobacco, banking readiness, coarse health-readiness flag), texts the agency's contact card, then live-transfers to a licensed advisor or books a callback. Stops cold at the regulated line — never quotes, recommends a carrier, underwrites, or collects SSN/bank/health details; those seven script sections are handed to the licensed advisor as a pre-filled closer brief instead.",
      // A5 (phase-a-integrity.md, 2026-08-24): repointed to the v2 file — the
      // v1 persona itself stated an unsourced "typical national cost" figure
      // for cremation, which is what production call 2 spoke on a recording
      // with no source (audit finding 8). v1 is left in place, unedited, per
      // ADR-118 (docs/agent-prompts/ is append-only and immovable).
      fileName: "09-insurance-final-expense-qualifier-agent-v2.md",
      // {{lead_name}} and {{interest_area}} removed (2026-08-17): same
      // leads-row dependency as the other insurance templates.
      literalGreetingTemplate: "Hi, this is {{agent_name}} with {{merchant_name}} — you'd recently reached out about final expense coverage, and I wanted to follow up. Do you have a couple of minutes?",
      // sendSms added so the "I'll text you our contact card" step in Section 4 is a real
      // capability rather than a promise the agent cannot keep.
      defaultTools: ["captureField", "markFieldUnanswered", "sendSms", "transferToHuman", "bookAppointment", "flagGuardrailEvent", "setDisposition", "setIntent", "crmSync"],
      active: true,
    },
    {
      // Real demo-call widget (2026-08-27,
      // docs/product-strategy/real-demo-call-widget-plan-2026-08-26.md) — freeform, no script,
      // reachable only from the public demo widget via `ownerOrgId`. See
      // docs/agent-prompts/10-weeber-pitch-agent.md for why it carries no appointment/CRM tools.
      key: "weeber-pitch-agent",
      name: "Weeber Pitch Agent (demo widget)",
      vertical: "demo",
      description: "Freeform agent that talks about the Weeber product itself and tries to capture an email for follow-up. Public demo-widget only — never offered in any merchant's catalog.",
      fileName: "10-weeber-pitch-agent.md",
      defaultTools: ["captureField", "markFieldUnanswered", "setDisposition", "setIntent"],
      active: true,
      visibility: "private",
      ownerOrgId: DEMO_ORG_ID,
    },
  ];

export async function seedAgentTemplates() {
  console.log("[db-seed] Seeding agent templates...");
  // packages/api/src/database -> repo root is 4 levels up, not 3 (D5, this
  // audit): the prompt files live at <repo-root>/docs/agent-prompts, not
  // packages/docs/agent-prompts. The off-by-one silently meant every
  // Bun.file(...).exists() check below returned false in every environment
  // (local and Railway alike), so seeding always skipped all 3 templates via
  // `continue` — while still logging "seeded successfully" unconditionally
  // at the end, regardless of whether anything was actually written.
  const promptsDir = join(import.meta.dir, "../../../../docs/agent-prompts");
  const templates = AGENT_TEMPLATES;

  // A private template's `ownerOrgId` FK requires that org to already exist. Ensured here
  // (idempotent, free — no Twilio/vendor calls) rather than in a separate one-off script, so
  // `weeber-pitch-agent` seeds cleanly on any environment's very first boot. Note this only
  // creates the org ROW; provisioning its dedicated phone numbers and binding them to the three
  // demo templates via `orgAgentConfigs` is a deliberate separate step (real Twilio cost) — see
  // the source plan's rollout sequencing.
  const ownerOrgIds = [...new Set(templates.map((t) => t.ownerOrgId).filter((id): id is string => Boolean(id)))];
  for (const orgId of ownerOrgIds) {
    // vertical: "shopify" is deliberate, not a placeholder — this one org hosts demo calls for
    // all three templates (insurance, Shopify, freeform), and `orgs.vertical === "insurance"`
    // would turn on the insurance-only producer-licensing/1600-series gates
    // (voice/compliance/insurance-gates.ts) for every one of this org's calls, not just the
    // insurance demo. This org never actually underwrites or sells insurance, so those gates
    // don't apply to it regardless of which template a given demo call used.
    await db.insert(orgs).values({ id: orgId, name: "Weeber Live Demo", vertical: "shopify" }).onConflictDoNothing();
  }

  let seededCount = 0;
  let skippedCount = 0;

  for (const t of templates) {
    try {
      const filePath = join(promptsDir, t.fileName);
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        console.error(`[db-seed] Prompt file does not exist at ${filePath}`);
        skippedCount++;
        continue;
      }
      // ADR-104: seed the RUNTIME region only, not the whole document. These
      // files are authoring documents — they carry a `**File:**` header, a
      // regulatory-grounding pointer, a "Why this template exists" rationale, a
      // tools mapping table and a "Known gap" note, all written to a human
      // maintainer. Writing the file verbatim into defaultPersonaPrompt meant
      // the model was handed 13-40% maintainer prose as if it were call
      // instructions. extractRuntimePersona THROWS when the markers are absent
      // rather than falling back to the whole file: the catch below turns that
      // into a loud per-template skip, which is the correct outcome, because a
      // silent whole-file fallback is precisely the defect being removed.
      const { runtime: promptContent } = extractRuntimePersona(await file.text(), t.fileName);

      const existing = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.key, t.key))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(agentTemplates)
          .set({
            name: t.name,
            vertical: t.vertical,
            description: t.description,
            defaultPersonaPrompt: promptContent,
            literalGreetingTemplate: t.literalGreetingTemplate ?? null,
            defaultTools: t.defaultTools,
            active: t.active,
            visibility: t.visibility ?? "public",
            ownerOrgId: t.ownerOrgId ?? null,
          })
          .where(eq(agentTemplates.key, t.key));
      } else {
        await db.insert(agentTemplates).values({
          key: t.key,
          name: t.name,
          vertical: t.vertical,
          description: t.description,
          defaultPersonaPrompt: promptContent,
          literalGreetingTemplate: t.literalGreetingTemplate ?? null,
          defaultTools: t.defaultTools,
          active: t.active,
          visibility: t.visibility ?? "public",
          ownerOrgId: t.ownerOrgId ?? null,
        });
      }
      seededCount++;
    } catch (err) {
      console.error(`[db-seed] failed to seed template ${t.key}:`, err);
      skippedCount++;
    }
  }

  // Previously logged "seeded successfully" unconditionally, even when every
  // template was skipped (see the promptsDir path fix above, D5) — that
  // false-positive log line is exactly what let the empty-templates-table
  // bug go unnoticed across every deploy until this audit.
  if (skippedCount > 0) {
    console.error(`[db-seed] ${seededCount}/${templates.length} agent templates seeded, ${skippedCount} skipped — see errors above.`);
  } else {
    console.log(`[db-seed] All ${seededCount} agent templates seeded successfully.`);
  }
}

export async function seedWorkflowTemplates() {
  console.log("[db-seed] Seeding workflow templates...");
  let seededCount = 0;
  let skippedCount = 0;
  let migratedCount = 0;
  for (const t of SHOPIFY_WORKFLOW_TEMPLATES) {
    try {
      const [existing] = await db
        .select()
        .from(workflowTemplates)
        .where(eq(workflowTemplates.id, t.id))
        .limit(1);
      if (existing) {
        // Self-healing compliance migration (2026-07-19): pre-v4 canonical
        // templates (e.g. the original cart-recovery graph) were seeded before
        // locked dncCheck/callingWindowCheck nodes were required, so plain
        // skip-if-exists would leave those rows non-compliant forever — a fork
        // of them fails validateLockedNodesEnforced on save. These rows are
        // canonical/system-owned (merchants fork into org_workflow_configs,
        // they never edit this table), so it's safe to overwrite the graph in
        // place when the stored one no longer passes the compliance validator.
        const check = validateLockedNodesEnforced(existing.graph);
        if (!check.valid) {
          await db
            .update(workflowTemplates)
            .set({ graph: t.graph, description: t.description, updatedAt: new Date() })
            .where(eq(workflowTemplates.id, t.id));
          console.log(
            `[db-seed] Workflow template "${t.id}" upgraded to v4-compliant graph (was: ${check.error}).`,
          );
          migratedCount++;
          continue;
        }
        // Keep the merchant-facing description copy in sync even for compliant
        // rows — descriptions are code-owned canonical copy (see seed-graph.ts)
        // and were added after these rows were first seeded, so a plain skip
        // would leave older rows with an empty description forever.
        if (existing.description !== t.description) {
          await db
            .update(workflowTemplates)
            .set({ description: t.description, updatedAt: new Date() })
            .where(eq(workflowTemplates.id, t.id));
          console.log(`[db-seed] Workflow template "${t.id}" description synced.`);
          migratedCount++;
          continue;
        }
        console.log(`[db-seed] Workflow template "${t.id}" already exists and is compliant — skipping.`);
        skippedCount++;
        continue;
      }
      await db.insert(workflowTemplates).values({
        id: t.id,
        vertical: t.vertical,
        name: t.name,
        description: t.description,
        graph: t.graph,
      });
      console.log(`[db-seed] Workflow template "${t.id}" seeded.`);
      seededCount++;
    } catch (err) {
      console.error(`[db-seed] failed to seed workflow template ${t.id}:`, err);
      skippedCount++;
    }
  }
  console.log(
    `[db-seed] Workflow templates: ${seededCount} seeded, ${migratedCount} migrated, ${skippedCount} skipped (of ${SHOPIFY_WORKFLOW_TEMPLATES.length}).`,
  );
}

/**
 * Real demo-call widget (2026-08-27) — seeds the global kill switch row disabled-by-default.
 * `feature_flags` has 0 production rows as of the 2026-08-25 audit, and `isGlobalFlagEnabled`
 * (voice/demo-widget-flag.ts) already fails closed on a missing row — this just makes the row
 * exist and explicit, rather than relying on "absent" to mean "off" forever. `onConflictDoNothing`
 * so flipping it on in production is never overwritten back to disabled by the next boot's seed.
 */
export async function seedDemoWidgetFlag() {
  await db
    .insert(featureFlags)
    .values({
      key: DEMO_WIDGET_FLAG_KEY,
      orgId: "",
      enabled: false,
      description: "Public landing-page live demo-call widget (POST /api/public/demo-call). Kill switch — flip only after Phase 1/2 verification per the source plan.",
    })
    .onConflictDoNothing();
}
