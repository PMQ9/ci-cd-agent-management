// Lifecycle wiring shared by every DB-backed test. Usage in a test file:
//
//   const holder = vi.hoisted(() => ({}) as DbHolder);
//   vi.mock("../src/db/client.js", () => ({
//     get db() { return holder.db; },
//     get pool() { return holder.pool; },
//   }));
//   installDbLifecycle(holder);
//
// The `vi.hoisted` + `vi.mock` MUST live in the test file itself (vitest only
// hoists them per-file), so db/client is mocked before queue.ts imports it.
// This helper just registers the beforeAll/afterAll/beforeEach hooks.
import { afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./db.js";

export type DbHolder = Partial<TestDb> & { db?: any; pool?: any };

export function installDbLifecycle(holder: DbHolder, opts?: { forceRealPg?: boolean }): void {
  beforeAll(async () => {
    const h = await createTestDb(opts);
    Object.assign(holder, h);
  });
  afterAll(async () => {
    await holder.close?.();
  });
  beforeEach(async () => {
    await holder.truncateAll?.();
  });
}
