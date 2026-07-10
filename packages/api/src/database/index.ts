import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Supabase Postgres (ADR-034). `prepare: false` because Supabase's
// transaction-mode pooler (port 6543, the recommended connection for
// serverless/many-connection apps) does not support prepared statements —
// and it's harmless on a direct/session connection too.
const client = postgres(process.env.DATABASE_URL!, { prepare: false });

export const db = drizzle(client, { schema });
