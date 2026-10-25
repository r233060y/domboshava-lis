// Entry point: node src/server.js
"use strict";
const config = require("./config").load();
const { createPools } = require("./db");
const { createApp } = require("./app");

// The net beneath the net (Manual §5.3.5): log, never die silently.
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));

const { publicPool, apiPool } = createPools(config);
const app = createApp({ publicPool, apiPool, config });

const server = app.listen(config.port, () => {
  console.log(`Domboshava register running at http://localhost:${config.port}/  (API at /api/)`);
});

async function shutdown(signal) {
  console.log(`${signal} received, closing.`);
  server.close();
  await Promise.allSettled([publicPool.end(), apiPool.end()]);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
