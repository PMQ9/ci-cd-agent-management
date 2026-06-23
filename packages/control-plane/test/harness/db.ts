// Test DB harness. Default backend is pglite (in-memory Postgres, no Docker);
// when TEST_DATABASE_URL is set — or { forceRealPg } is passed — it uses a real
// Postgres pool instead (the SKIP LOCKED concurrency suite needs true
// multi-connection contention pglite's single connection can't reproduce).
//
// Either way it applies the SAME committed migrations the app ships
// (packages/control-plane/drizzle) and exposes truncateAll() for per-test reset.
import { fileURLToPath } from "node:url";
import * as schema from "../../src/db/schema.js";

// All tables in the schema. TRUNCATE ... CASCADE makes FK order irrelevant.
const TABLES = [
  "users",
  "installations",
  "repos",
  "pull_requests",
  "runners",
  "jobs",
  "reviews",
  "findings",
  "usage_events",
  "templates",
  "agent_prompts",
] as const;

export interface TestDb {
  // drizzle instance (node-postgres or pglite flavour — same query API)
  db: any;
  pool?: any;
  pglite?: any;
  mode: "pglite" | "pg";
  truncateAll: () => Promise<void>;
  close: () => Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function realPgAvailable(): boolean {
  return Boolean(process.env.TEST_DATABASE_URL);
}

// IMPORTANT: real Postgres is opt-in PER FILE via { forceRealPg: true } — NOT
// implicitly enabled by TEST_DATABASE_URL. pglite gives each test file its own
// isolated in-memory instance, so files can truncate freely in parallel. A shared
// real Postgres can't do that safely (parallel files would clobber each other's
// truncations), so only the suite that genuinely needs multi-connection contention
// (the SKIP LOCKED concurrency test) forces real PG; everything else stays on pglite.
export async function createTestDb(opts?: { forceRealPg?: boolean }): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  const useRealPg = opts?.forceRealPg === true;

  if (useRealPg) {
    if (!url) throw new Error("real Postgres requested but TEST_DATABASE_URL is not set");
    const pg = (await import("pg")).default;
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
    return {
      db,
      pool,
      mode: "pg",
      truncateAll: async () => {
        await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
      },
      close: async () => {
        await pool.end();
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return {
    db,
    pglite: client,
    mode: "pglite",
    truncateAll: async () => {
      await client.exec(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE;`);
    },
    close: async () => {
      await client.close();
    },
  };
}
