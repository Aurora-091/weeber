import { mock, describe, it, expect, beforeEach, afterAll } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";

/**
 * Bespoke agent templates (2026-08-09).
 *
 * Two things under test, because the feature is only correct if both hold:
 *   1. the visibility predicate itself — what SQL it actually produces, since a
 *      predicate that silently widens is the failure mode that leaks one
 *      account's persona prompt to another;
 *   2. the admin grant route — validation, the refusal to reassign someone
 *      else's private template, and idempotency.
 */

let rowsByTable: Record<string, unknown[]> = {};
let insertsByTable: Record<string, Record<string, unknown>[]> = {};
let updatesByTable: Record<string, Record<string, unknown>[]> = {};
let conflictSkip = false;

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

// Every `where(...)` predicate handed to the fake db, so a query that is
// *supposed* to be visibility-scoped can be asserted on directly — the fake
// itself ignores predicates, so without this a read that dropped its scoping
// would still return rows and the test would pass.
let capturedWheres: unknown[] = [];

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.where = (cond: unknown) => {
    capturedWheres.push(cond);
    return thenable(rows);
  };
  promise.limit = () => thenable(rows);
  promise.orderBy = () => thenable(rows);
  promise.innerJoin = () => thenable(rows);
  return promise;
}

const dbLike = {
  select: () => ({
    from: (table: unknown) => thenable(rowsByTable[getTableName(table) ?? ""] ?? []),
  }),
  insert: (table: unknown) => ({
    values: (data: Record<string, unknown>) => {
      const name = getTableName(table) ?? "";
      (insertsByTable[name] ??= []).push(data);
      const returned = conflictSkip ? [] : [{ id: 1, ...data }];
      // Awaitable *and* chainable: callers do both (`await db.insert().values()`
      // in audit-log, `.onConflictDoNothing().returning()` here).
      const chain = Promise.resolve(returned) as Promise<unknown[]> & Record<string, unknown>;
      chain.onConflictDoNothing = () => ({ returning: () => Promise.resolve(returned) });
      chain.onConflictDoUpdate = () => ({ returning: () => Promise.resolve([{ id: 1, ...data }]) });
      chain.returning = () => Promise.resolve([{ id: 1, ...data }]);
      return chain;
    },
  }),
  update: (table: unknown) => ({
    set: (data: Record<string, unknown>) => ({
      where: () => {
        const name = getTableName(table) ?? "";
        (updatesByTable[name] ??= []).push(data);
        return { returning: () => Promise.resolve([{ id: 1, ...data }]) };
      },
    }),
  }),
  delete: () => ({ where: () => Promise.resolve() }),
};

// ADR-116 addendum: admin-routes.ts and audit-log.ts now import `dbBackground`
// — both names must resolve here or the import throws.
mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

process.env.ADMIN_API_KEY = "test-admin-key";
afterAll(() => {
  delete process.env.ADMIN_API_KEY;
});

import { admin } from "./admin-routes";
import { agentTemplates } from "../database/schema";
import {
  isTemplateVisibility,
  isTemplateVisibleToOrg,
  loadVisibleTemplate,
  visibleTemplatesForOrg,
  visibleTemplatesForVertical,
} from "./template-visibility";

const adminHeaders = { "X-Weeber-Admin-Key": "test-admin-key", "Content-Type": "application/json" };
const dialect = new PgDialect();

function render(sql: Parameters<PgDialect["sqlToQuery"]>[0]) {
  const q = dialect.sqlToQuery(sql);
  return { text: q.sql, params: q.params };
}

describe("template visibility predicate", () => {
  it("accepts only the two known visibilities", () => {
    expect(isTemplateVisibility("public")).toBe(true);
    expect(isTemplateVisibility("private")).toBe(true);
    expect(isTemplateVisibility("PRIVATE")).toBe(false);
    expect(isTemplateVisibility("")).toBe(false);
    expect(isTemplateVisibility(undefined)).toBe(false);
  });

  it("without an org, offers the public catalog for that vertical only", () => {
    const { text, params } = render(visibleTemplatesForVertical("insurance"));
    expect(text).toContain('"visibility"');
    expect(text).toContain('"vertical"');
    expect(text).not.toContain("owner_org_id");
    expect(params).toEqual(["public", "insurance"]);
  });

  it("with an org, offers the vertical's public catalog OR that org's private templates", () => {
    const { text, params } = render(visibleTemplatesForVertical("insurance", "org-peterson"));
    expect(text).toContain(" or ");
    expect(text).toContain("owner_org_id");
    expect(params).toEqual(["public", "insurance", "private", "org-peterson"]);
  });

  it("never matches a private template with a null owner", () => {
    const { text } = render(visibleTemplatesForVertical("insurance", "org-peterson"));
    // Fail-closed guard: the owner comparison is paired with an explicit
    // not-null check so a null owner can never satisfy the private branch.
    expect(text).toContain("is not null");
  });

  it("by-key resolution drops the vertical narrowing but keeps the ownership rule", () => {
    const { text, params } = render(visibleTemplatesForOrg("org-peterson"));
    expect(text).not.toContain('"vertical"');
    expect(params).toEqual(["public", "private", "org-peterson"]);
  });

  it("by-key resolution with no org sees public templates only", () => {
    const { text, params } = render(visibleTemplatesForOrg());
    expect(text).not.toContain("owner_org_id");
    expect(params).toEqual(["public"]);
  });

  it("composes with other conditions without losing the OR grouping", () => {
    // Regression guard: an un-parenthesized OR next to an AND would make every
    // public template visible to every org regardless of `active`.
    const { text } = render(
      and(eq(agentTemplates.active, true), visibleTemplatesForVertical("insurance", "org-peterson"))!,
    );
    expect(text).toMatch(/\(.*or.*\)/s);
  });
});

describe("by-key template reads (ADR-091)", () => {
  const PUBLIC_ROW = {
    id: 9,
    key: "insurance-final-expense-qualifier",
    vertical: "insurance",
    active: true,
    visibility: "public",
    ownerOrgId: null,
  };

  beforeEach(() => {
    capturedWheres = [];
    rowsByTable = { agent_templates: [PUBLIC_ROW] };
  });

  it("scopes the by-key read with the visibility predicate, not just the key", () => {
    // The bug ADR-091 fixes: `where(eq(agentTemplates.key, key))` on its own.
    // `templateKey` is a caller-supplied URL path param, so an unscoped by-key
    // read hands back another account's defaultPersonaPrompt.
    loadVisibleTemplate("bespoke", "org-peterson");
    expect(capturedWheres).toHaveLength(1);
    const { text, params } = render(capturedWheres[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(text).toContain('"key"');
    expect(text).toContain("owner_org_id");
    expect(params).toEqual(["bespoke", "public", "private", "org-peterson"]);
  });

  it("narrows to the public catalog when no org is supplied (fail closed)", () => {
    loadVisibleTemplate("bespoke");
    const { text, params } = render(capturedWheres[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(text).not.toContain("owner_org_id");
    expect(params).toEqual(["bespoke", "public"]);
  });

  it("does not filter on `active` — a call in flight on a retired template must still resolve", () => {
    loadVisibleTemplate("bespoke", "org-peterson");
    const { text } = render(capturedWheres[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(text).not.toContain('"active"');
  });

  it("returns null rather than a partial row when nothing matches", async () => {
    rowsByTable.agent_templates = [];
    expect(await loadVisibleTemplate("ghost", "org-peterson")).toBeNull();
  });

  it("returns the row when it is visible", async () => {
    expect(await loadVisibleTemplate("insurance-final-expense-qualifier", "org-peterson")).toMatchObject({
      key: "insurance-final-expense-qualifier",
    });
  });

  it("isTemplateVisibleToOrg answers yes/no off the same predicate", async () => {
    expect(await isTemplateVisibleToOrg("insurance-final-expense-qualifier", "org-peterson")).toBe(true);
    const { params } = render(capturedWheres[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(params).toEqual(["insurance-final-expense-qualifier", "public", "private", "org-peterson"]);

    rowsByTable.agent_templates = [];
    expect(await isTemplateVisibleToOrg("bespoke", "org-peterson")).toBe(false);
  });
});

describe("admin agent-template grant route", () => {
  beforeEach(() => {
    conflictSkip = false;
    rowsByTable = {
      orgs: [{ id: "org-peterson" }],
      agent_templates: [
        { id: 9, key: "insurance-final-expense-qualifier", vertical: "insurance", active: true, visibility: "public", ownerOrgId: null },
      ],
      org_agent_configs: [],
      admin_audit_log: [],
    };
    insertsByTable = {};
    updatesByTable = {};
  });

  it("requires the admin key", async () => {
    const res = await admin.request("/orgs/org-peterson/agents/grant", {
      method: "POST",
      body: JSON.stringify({ templateKey: "insurance-final-expense-qualifier" }),
    });
    expect(res.status).toBe(401);
  });

  it("400s without a templateKey", async () => {
    const res = await admin.request("/orgs/org-peterson/agents/grant", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown template", async () => {
    rowsByTable.agent_templates = [];
    const res = await admin.request("/orgs/org-peterson/agents/grant", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ templateKey: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("404s for an unknown org", async () => {
    rowsByTable.orgs = [];
    const res = await admin.request("/orgs/ghost/agents/grant", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ templateKey: "insurance-final-expense-qualifier" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s on an inactive template", async () => {
    rowsByTable.agent_templates = [
      { id: 9, key: "retired", vertical: "insurance", active: false, visibility: "public", ownerOrgId: null },
    ];
    const res = await admin.request("/orgs/org-peterson/agents/grant", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ templateKey: "retired" }),
    });
    expect(res.status).toBe(400);
  });

  it("409s rather than reassigning another org's private template", async () => {
    rowsByTable.agent_templates = [
      { id: 9, key: "bespoke", vertical: "insurance", active: true, visibility: "private", ownerOrgId: "org-someone-else" },
    ];
    const res = await admin.request("/orgs/org-peterson/agents/grant", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ templateKey: "bespoke" }),
    });
    expect(res.status).toBe(409);
    expect(updatesByTable.agent_templates).toBeUndefined();
    expect(insertsByTable.org_agent_configs).toBeUndefined();
  });

  it("enables the template for the org and reports it as newly created", async () => {
    const res = await admin.request("/orgs/org-peterson/agents/grant", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ templateKey: "insurance-final-expense-qualifier" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, orgId: "org-peterson", created: true });
    expect(insertsByTable.org_agent_configs?.[0]).toMatchObject({
      orgId: "org-peterson",
      templateKey: "insurance-final-expense-qualifier",
      enabled: true,
    });
    // Not asked to claim it, so a catalog template stays public.
    expect(updatesByTable.agent_templates).toBeUndefined();
  });

  it("claims the template for the org when makePrivate is set", async () => {
    const res = await admin.request("/orgs/org-peterson/agents/grant", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ templateKey: "insurance-final-expense-qualifier", makePrivate: true }),
    });
    expect(res.status).toBe(200);
    expect(updatesByTable.agent_templates?.[0]).toMatchObject({ visibility: "private", ownerOrgId: "org-peterson" });
  });

  it("is idempotent: a second grant reports created=false and overwrites nothing", async () => {
    conflictSkip = true;
    const res = await admin.request("/orgs/org-peterson/agents/grant", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ templateKey: "insurance-final-expense-qualifier" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: false });
  });
});

describe("admin agent-template visibility validation", () => {
  beforeEach(() => {
    conflictSkip = false;
    rowsByTable = {
      orgs: [{ id: "org-peterson" }],
      agent_templates: [],
      org_agent_configs: [],
      admin_audit_log: [],
    };
    insertsByTable = {};
    updatesByTable = {};
  });

  it("rejects an unknown visibility on create", async () => {
    const res = await admin.request("/agent-templates", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ vertical: "insurance", key: "k", name: "N", visibility: "secret" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a private template with no owner on create", async () => {
    const res = await admin.request("/agent-templates", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ vertical: "insurance", key: "k", name: "N", visibility: "private" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s a private template pointed at an org that doesn't exist", async () => {
    rowsByTable.orgs = [];
    const res = await admin.request("/agent-templates", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ vertical: "insurance", key: "k", name: "N", visibility: "private", ownerOrgId: "ghost" }),
    });
    expect(res.status).toBe(404);
  });

  it("creates a private template owned by a real org", async () => {
    const res = await admin.request("/agent-templates", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        vertical: "insurance",
        key: "peterson-final-expense",
        name: "Peterson qualifier",
        visibility: "private",
        ownerOrgId: "org-peterson",
      }),
    });
    expect(res.status).toBe(201);
    expect(insertsByTable.agent_templates?.[0]).toMatchObject({ visibility: "private", ownerOrgId: "org-peterson" });
  });

  it("defaults a created template to public with no owner", async () => {
    const res = await admin.request("/agent-templates", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ vertical: "insurance", key: "k", name: "N" }),
    });
    expect(res.status).toBe(201);
    expect(insertsByTable.agent_templates?.[0]).toMatchObject({ visibility: "public", ownerOrgId: null });
  });

  it("refuses an update that would leave a private template ownerless", async () => {
    rowsByTable.agent_templates = [
      { id: 9, key: "bespoke", vertical: "insurance", active: true, visibility: "private", ownerOrgId: "org-peterson" },
    ];
    const res = await admin.request("/agent-templates/bespoke", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ ownerOrgId: null }),
    });
    expect(res.status).toBe(400);
    expect(updatesByTable.agent_templates).toBeUndefined();
  });

  it("allows flipping a private template back to public and clearing its owner", async () => {
    rowsByTable.agent_templates = [
      { id: 9, key: "bespoke", vertical: "insurance", active: true, visibility: "private", ownerOrgId: "org-peterson" },
    ];
    const res = await admin.request("/agent-templates/bespoke", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ visibility: "public", ownerOrgId: null }),
    });
    expect(res.status).toBe(200);
    expect(updatesByTable.agent_templates?.[0]).toMatchObject({ visibility: "public", ownerOrgId: null });
  });
});
