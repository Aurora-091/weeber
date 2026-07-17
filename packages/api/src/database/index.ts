import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

import { DrizzleLogger } from "./logger";

// Supabase Postgres (ADR-034). `prepare: false` because Supabase's
// transaction-mode pooler (port 6543, the recommended connection for
// serverless/many-connection apps) does not support prepared statements —
// and it's harmless on a direct/session connection too.
//
// `max` (2026-07-17, Audit #7 follow-up) — this client previously had no
// explicit pool size, which meant postgres-js's own default of 10. That's
// this process's own client-side pool to the pooler, not a direct cap on
// Supabase's underlying Postgres max_connections (confirmed 60 on this
// project's current compute tier via `SHOW max_connections`) — port 6543 is
// Supavisor's transaction-mode pooler, which already multiplexes many
// client connections onto a smaller, separately-limited set of real
// Postgres backend connections. So this value isn't "how many Postgres
// connections we use" directly, it's "how many logical client connections
// this ONE replica opens to the pooler" — the real cross-replica math once
// horizontal scaling is actually turned on is:
//   (replica count) × DATABASE_POOL_MAX  <=  Supavisor's own client-connection
//   ceiling for whatever Supabase compute tier is active at the time.
// That ceiling scales with Supabase's compute add-on size and hasn't been
// queried directly (needs Supabase's own management API/dashboard, not
// just SQL against the DB) — see docs/resources.md's Supabase section.
// Configurable via DATABASE_POOL_MAX so this can be tuned per-deployment
// without a code change once real replica counts are decided; default (20)
// is deliberately just headroom over the previous unconfigured default of
// 10, sized for today's single-replica reality, not a Pro-plan-scale value.
const client = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: Number(process.env.DATABASE_POOL_MAX ?? 20),
});

export const db = drizzle(client, { schema, logger: new DrizzleLogger() });
