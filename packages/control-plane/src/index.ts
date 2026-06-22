import { env } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { sweepExpiredLeases } from "./queue.js";
import { buildServer } from "./server.js";

if (env.AUTO_MIGRATE !== "false") {
  await runMigrations();
}

const app = await buildServer();

// Requeue jobs whose runner died mid-lease. Disabled on Cloud Run scale-to-zero
// (ENABLE_INPROCESS_SWEEP=false), where the frozen instance can't fire timers —
// Cloud Scheduler → POST /internal/sweep handles it there instead.
let sweepTimer: ReturnType<typeof setInterval> | undefined;
if (env.ENABLE_INPROCESS_SWEEP !== "false") {
  sweepTimer = setInterval(() => {
    sweepExpiredLeases()
      .then((n) => {
        if (n) app.log.info({ requeued: n }, "swept expired leases");
      })
      .catch((err) => app.log.error({ err }, "lease sweep failed"));
  }, 30_000);
  sweepTimer.unref();
}

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (sweepTimer) clearInterval(sweepTimer);
    void app.close().then(() => process.exit(0));
  });
}
