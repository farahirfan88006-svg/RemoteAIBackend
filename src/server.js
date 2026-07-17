import { env } from "./config/env.js";
import { connectDatabase } from "./config/db.js";
import { createApp } from "./app.js";
import { startSyncScheduler } from "./sync/runSync.js";

/**
 * Process entrypoint. This is the only file in the codebase that:
 *   - connects to MongoDB
 *   - starts the HTTP listener
 *   - handles process-level signals
 *
 * Keeping this separate from app.js means the Express app itself stays
 * a plain, importable, listen-free module (useful for future testing),
 * while all "this process is now live" concerns live in exactly one place.
 */
async function start() {
  await connectDatabase();

  const app = createApp();

  const server = app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.info(`[server] RemoteAI backend listening on port ${env.port} (${env.nodeEnv})`);
  });

  // Phase 3: recurring job sync (Greenhouse/Lever/Ashby/Arbeitnow/USAJobs).
  // Scheduling only — never blocks the server from accepting requests,
  // including its optional immediate SYNC_ON_BOOT run.
  startSyncScheduler();

  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.info(`[server] Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      // eslint-disable-next-line no-console
      console.info("[server] Closed remaining connections. Exiting.");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[server] Fatal startup error:", error);
  process.exit(1);
});
