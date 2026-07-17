import mongoose from "mongoose";

import { env } from "./env.js";

/**
 * MongoDB connection, established once at process startup and reused by
 * every model/query in the app (Mongoose maintains a single connection
 * pool internally, so there is no per-request connect/disconnect).
 *
 * A failed database connection is treated as fatal at startup: an API
 * server that can't reach its database has no useful work to do, so we
 * fail fast and let the host platform (Render) restart the process,
 * rather than serving requests against a connection that will only error
 * later, in a less predictable place.
 */
export async function connectDatabase() {
  mongoose.connection.on("disconnected", () => {
    // eslint-disable-next-line no-console
    console.warn("[db] MongoDB connection lost");
  });

  mongoose.connection.on("reconnected", () => {
    // eslint-disable-next-line no-console
    console.info("[db] MongoDB reconnected");
  });

  try {
    await mongoose.connect(env.mongodbUri, {
      // Fail within a few seconds if the cluster is unreachable, rather
      // than hanging on Mongoose's default 30s server-selection timeout —
      // consistent with the fail-fast philosophy applied to env vars.
      serverSelectionTimeoutMS: 5000,
    });
    // eslint-disable-next-line no-console
    console.info("[db] MongoDB connected");
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[db] MongoDB connection failed:", error);
    process.exit(1);
  }
}

export function isDatabaseConnected() {
  // readyState 1 === connected
  return mongoose.connection.readyState === 1;
}
