// Connection pools (Manual §5.3.1): never a connection per request.
"use strict";
const { Pool } = require("pg");

function createPools(config) {
  const publicPool = new Pool({ ...config.publicDb, max: 10, idleTimeoutMillis: 30000 });
  const apiPool = new Pool({ ...config.apiDb, max: 10, idleTimeoutMillis: 30000 });
  // An idle client that loses its connection must not crash the process.
  for (const pool of [publicPool, apiPool]) {
    pool.on("error", (err) => console.error("Idle database client error:", err.message));
  }
  return { publicPool, apiPool };
}

// Run fn inside one transaction on a checked-out client, with the
// application user declared so the audit trigger can attribute every
// change to a named person (Manual §4.5.3). The third argument of
// set_config (true) scopes the setting to this transaction only.
async function withUser(pool, username, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('lis.current_user', $1, true)", [username]);
    const result = await fn(client);
    await client.query("COMMIT");          // deferred constraints (share sums) are checked here
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection may already be gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPools, withUser };
