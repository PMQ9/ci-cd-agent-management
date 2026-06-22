import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./client.js";

function migrationsFolder(): string {
  const candidates = [
    fileURLToPath(new URL("../../drizzle", import.meta.url)),
    resolve(process.cwd(), "drizzle"),
    resolve(process.cwd(), "packages/control-plane/drizzle"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

export async function runMigrations(): Promise<void> {
  const folder = migrationsFolder();
  console.log(`[migrate] applying migrations from ${folder}`);
  await migrate(db, { migrationsFolder: folder });
  console.log("[migrate] done");
}
