import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config.js";
import * as schema from "./schema.js";

function sslConfig(): pg.PoolConfig["ssl"] {
  switch (env.DATABASE_SSL) {
    case "disable":
      return undefined;
    case "no-verify":
      return { rejectUnauthorized: false };
    case "require":
      return { rejectUnauthorized: true };
    default: {
      // auto: SSL on for remote DBs (Neon, etc.), off for local/compose Postgres.
      const isLocal = /@(localhost|127\.0\.0\.1|postgres)(:\d+)?\//.test(env.DATABASE_URL);
      return isLocal ? undefined : { rejectUnauthorized: true };
    }
  }
}

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  ssl: sslConfig(),
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
