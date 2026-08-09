/**
 * Who is allowed to see (and therefore run) an agent template.
 *
 * The catalog used to be implicitly global: `agent_templates` was filtered by
 * `vertical` + `active` only, so every active template for a vertical was
 * offered to every org in that vertical, and any code path that resolved a
 * template *by key* (persona resolution in agent.ts) would happily hand back
 * another account's persona prompt if the key was guessed or leaked.
 *
 * One predicate, used by every org-scoped read, so "who can see this template"
 * has a single definition:
 *
 *   public                       -> visible to any org whose vertical matches
 *   private + ownerOrgId = org   -> visible to that org, regardless of vertical
 *                                   (a bespoke template is written for an
 *                                   account, not for a category)
 *   private + any other owner    -> invisible
 *   private + ownerOrgId = null  -> invisible to everyone (fail closed)
 *
 * `active` is deliberately NOT folded in here: it means "still offered", which
 * is a different question from "belongs to you", and some callers (admin
 * catalog, key resolution for a call already in flight on a since-retired
 * template) need one without the other.
 */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { agentTemplates } from "../database/schema";

export const TEMPLATE_VISIBILITIES = ["public", "private"] as const;
export type TemplateVisibility = (typeof TEMPLATE_VISIBILITIES)[number];

export function isTemplateVisibility(value: unknown): value is TemplateVisibility {
  return typeof value === "string" && (TEMPLATE_VISIBILITIES as readonly string[]).includes(value);
}

/**
 * Templates this org may see, by vertical: the vertical's public catalog plus
 * anything privately allocated to this org. Pass no orgId (internal/no-tenant
 * contexts that still want a vertical listing) to get the public catalog only.
 */
export function visibleTemplatesForVertical(vertical: string, orgId?: string): SQL {
  const publicForVertical = and(eq(agentTemplates.visibility, "public"), eq(agentTemplates.vertical, vertical));
  if (!orgId) return publicForVertical as SQL;
  return or(publicForVertical, ownedPrivately(orgId)) as SQL;
}

/**
 * Templates this org may resolve *by key* — same rule as above minus the
 * vertical narrowing, because a key that came from a stored config row or a
 * scheduled call is already tied to this org. Used to stop a caller-supplied
 * template key from reaching another tenant's persona prompt.
 */
export function visibleTemplatesForOrg(orgId?: string): SQL {
  if (!orgId) return eq(agentTemplates.visibility, "public") as SQL;
  return or(eq(agentTemplates.visibility, "public"), ownedPrivately(orgId)) as SQL;
}

/** private AND owned by this org. Kept separate so the null-owner case can never widen. */
function ownedPrivately(orgId: string): SQL {
  return and(
    eq(agentTemplates.visibility, "private"),
    sql`${agentTemplates.ownerOrgId} is not null`,
    eq(agentTemplates.ownerOrgId, orgId),
  ) as SQL;
}
