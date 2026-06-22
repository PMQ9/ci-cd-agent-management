import { pool } from "./client.js";
import { runMigrations } from "./migrate.js";

await runMigrations();
await pool.end();
