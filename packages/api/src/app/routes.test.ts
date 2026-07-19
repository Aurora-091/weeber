import { mock, describe, it, expect, beforeEach } from "bun:test";
import { sign } from "hono/jwt";

/**
 * User /api/app surface: first-login org bootstrap (idempotent) and the
 * org gate on every non-/me route.
 */

let rowsByTable: Record<string, unknown[]> = {};
let insertsByTable: Record<string, unknown[]> = {};

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.where = () => thenable(rows);
  promise.limit = () => thenable(rows);
  promise.orderBy = () => thenable(rows);
  return promise;
}

mock.module("../database", () => {
  const dbLike = {
    select: () => ({
      from: (table: unknown) => thenable(rowsByTable[getTableName(table) ?? ""] ?? []),
    }),
    insert: (table: unknown) => ({
      values: (data: Record<string, unknown>) => {
        const name = getTableName(table) ?? "";
        (insertsByTable[name] ??= []).push(data);
        // Make bootstrap inserts visible to the re-select that follows them.
        (rowsByTable[name] ??= []).push(data);
        return {
          // Awaitable (existing callers just await it) AND chainable with
          // .returning() (provisionVerticalDefaults reads back what it wrote).
          onConflictDoNothing: () => {
            const p = Promise.resolve([]) as Promise<unknown[]> & Record<string, unknown>;
            p.returning = () => Promise.resolve([{ id: 1, ...data }]);
            return p;
          },
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve([data]) }),
          returning: () => Promise.resolve([{ id: 1, ...data }]),
        };
      },
    }),
  };
  return {
    db: {
      ...dbLike,
      // resolveOrCreateMembership wraps its two inserts in a real
      // transaction in production — this mock just runs the callback
      // against the same non-transactional dbLike, since a unit test has
      // no real Postgres connection to roll back against anyway.
      transaction: async (fn: (tx: typeof dbLike) => Promise<unknown>) => fn(dbLike),
    },
  };
});

process.env.SUPABASE_JWT_SECRET = "test-jwt-secret";

let lastResolveAgentConfigArgs: unknown = null;
let lastBuildPreviewArgs: unknown = null;

mock.module("../voice/agent", () => ({
  resolveAgentConfig: async (opts: unknown) => {
    lastResolveAgentConfigArgs = opts;
    return { systemPrompt: "saved-config-prompt" };
  },
  buildPreviewAgentConfig: async (templateKey: string, override: unknown) => {
    lastBuildPreviewArgs = { templateKey, override };
    return { systemPrompt: "preview-override-prompt" };
  },
  voiceTools: {},
  buildVoiceTools: () => ({}),
  buildKnownFactsBlock: () => "",
}));

mock.module("ai", () => ({
  streamText: () => ({
    textStream: (async function* () {
      yield "ok";
    })(),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
  }),
  stepCountIs: () => () => true,
}));

mock.module("../voice/llm", () => ({
  resolveVoiceModel: () => ({}),
  getActiveModelLabel: () => "test-model",
  estimateLlmCost: () => 0,
  resolveLlmProvider: () => "gateway",
}));

import { userApp } from "./routes";

async function bearer(sub: string, email?: string) {
  const token = await sign(
    { sub, email, exp: Math.floor(Date.now() / 1000) + 600 },
    "test-jwt-secret",
    "HS256",
  );
  return { Authorization: `Bearer ${token}` };
}

describe("user /api/app routes", () => {
  beforeEach(() => {
    rowsByTable = { org_members: [], orgs: [], calls: [], feature_flags: [] };
    insertsByTable = {};
  });

  it("bootstraps an org + owner membership on first /me", async () => {
    const res = await userApp.request("/me", { headers: await bearer("user-new", "jane@shop.com") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { org: { id: string; name: string }; role: string };
    expect(body.role).toBe("owner");
    expect(body.org.id.startsWith("org_")).toBe(true);
    expect(body.org.name).toBe("jane's workspace");
    expect(insertsByTable.orgs).toHaveLength(1);
    expect(insertsByTable.org_members).toHaveLength(1);
  });

  it("does not create a second org for an already-bootstrapped user", async () => {
    rowsByTable.org_members = [{ supabaseUserId: "user-1", orgId: "org-existing", role: "owner" }];
    rowsByTable.orgs = [{ id: "org-existing", name: "Existing", vertical: "shopify" }];
    const res = await userApp.request("/me", { headers: await bearer("user-1") });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { org: { id: string } }).org.id).toBe("org-existing");
    expect(insertsByTable.orgs).toBeUndefined();
    expect(insertsByTable.org_members).toBeUndefined();
  });

  it("403s org-gated routes when the session has no membership", async () => {
    const res = await userApp.request("/calls", { headers: await bearer("user-orphan") });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("no_org");
  });

  it("serves org-gated routes for a member", async () => {
    rowsByTable.org_members = [{ supabaseUserId: "user-1", orgId: "org-1", role: "owner" }];
    const res = await userApp.request("/calls", { headers: await bearer("user-1") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ calls: [] });
  });
});

describe("POST /agent-configs/:templateKey/test-chat — Preview drawer's live-edit path", () => {
  beforeEach(() => {
    rowsByTable = { org_members: [{ supabaseUserId: "user-1", orgId: "org-1", role: "owner" }], orgs: [], calls: [], feature_flags: [] };
    insertsByTable = {};
    lastResolveAgentConfigArgs = null;
    lastBuildPreviewArgs = null;
  });

  it("uses buildPreviewAgentConfig (live form state) when configOverride is present, not the saved DB row", async () => {
    const res = await userApp.request("/agent-configs/shopify-cart-recovery/test-chat", {
      method: "POST",
      headers: { ...(await bearer("user-1")), "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        configOverride: { personaPrompt: "unsaved edit", toneStyle: "friendly" },
      }),
    });
    expect(res.status).toBe(200);
    expect(lastBuildPreviewArgs).toEqual({
      templateKey: "shopify-cart-recovery",
      override: { personaPrompt: "unsaved edit", toneStyle: "friendly" },
    });
    expect(lastResolveAgentConfigArgs).toBeNull();
  });

  it("falls back to resolveAgentConfig (saved row) when configOverride is omitted", async () => {
    const res = await userApp.request("/agent-configs/shopify-cart-recovery/test-chat", {
      method: "POST",
      headers: { ...(await bearer("user-1")), "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(lastResolveAgentConfigArgs).toEqual({ orgId: "org-1", templateKey: "shopify-cart-recovery" });
    expect(lastBuildPreviewArgs).toBeNull();
  });

  it("rejects a configOverride that fails AgentFrameSchema validation", async () => {
    const res = await userApp.request("/agent-configs/shopify-cart-recovery/test-chat", {
      method: "POST",
      headers: { ...(await bearer("user-1")), "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        configOverride: { voiceProvider: "not-a-real-provider" },
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /provision-defaults — setup wizard auto-provisioning (HTTP-level)", () => {
  beforeEach(() => {
    rowsByTable = {
      org_members: [{ supabaseUserId: "user-1", orgId: "org-1", role: "owner" }],
      orgs: [{ id: "org-1", name: "Shop", vertical: "shopify" }],
      calls: [],
      feature_flags: [],
      agent_templates: [
        { key: "shopify-cart-recovery", vertical: "shopify", active: true },
        { key: "shopify-cod-confirmation", vertical: "shopify", active: true },
        { key: "shopify-feedback", vertical: "shopify", active: true },
      ],
      workflow_templates: [{ id: "shopify-cart-recovery-v1", vertical: "shopify", active: true }],
      org_agent_configs: [],
      org_workflow_configs: [],
    };
    insertsByTable = {};
  });

  it("enables the shopify vertical's recommended agents + workflow through the real route + org gate", async () => {
    const res = await userApp.request("/provision-defaults", {
      method: "POST",
      headers: await bearer("user-1"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vertical: string; agentsEnabled: string[]; workflowsEnabled: string[] };
    expect(body.vertical).toBe("shopify");
    // Curated money agents on; feedback intentionally NOT auto-enabled.
    expect(body.agentsEnabled).toContain("shopify-cart-recovery");
    expect(body.agentsEnabled).toContain("shopify-cod-confirmation");
    expect(body.agentsEnabled).not.toContain("shopify-feedback");
    expect(body.workflowsEnabled).toEqual(["shopify-cart-recovery-v1"]);
    // Actually wrote enabled rows.
    expect(insertsByTable.org_agent_configs).toHaveLength(2);
    expect((insertsByTable.org_agent_configs as { enabled: boolean }[]).every((r) => r.enabled)).toBe(true);
  });

  it("403s without a membership (org gate applies)", async () => {
    rowsByTable.org_members = [];
    const res = await userApp.request("/provision-defaults", {
      method: "POST",
      headers: await bearer("user-orphan"),
    });
    expect(res.status).toBe(403);
  });
});
