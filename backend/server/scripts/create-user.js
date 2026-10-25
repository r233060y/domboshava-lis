// Create a clerk or administrator account.
//
//   node scripts/create-user.js <username> <clerk|admin> "<Display name>" | psql -d domboshava_lis
//
// You are asked for the password (or set NEW_USER_PASSWORD). The script
// prints one INSERT statement containing only the scrypt hash, to be run
// as the database owner: the API's own role cannot create users, so a
// compromised API cannot create itself an administrator.
"use strict";
const readline = require("node:readline");
const { hashPassword } = require("../src/auth");

async function main() {
  const [username, role, displayName] = process.argv.slice(2);
  if (!username || !role || !displayName || !/^[a-z][a-z0-9_.]{2,31}$/.test(username) || !["clerk", "admin"].includes(role)) {
    console.error('Usage: node scripts/create-user.js <username> <clerk|admin> "<Display name>"');
    console.error("Username: 3-32 characters, lower case letters, digits, dot or underscore, starting with a letter.");
    process.exit(1);
  }
  let password = process.env.NEW_USER_PASSWORD;
  if (!password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    password = await new Promise((resolve) => rl.question(`Password for ${username}: `, (a) => { rl.close(); resolve(a); }));
  }
  if (!password || password.length < 10) {
    console.error("Use a password of at least 10 characters.");
    process.exit(1);
  }
  const hash = await hashPassword(password);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  process.stdout.write(
    `INSERT INTO lis.app_user (username, display_name, role, password_hash) VALUES (${q(username)}, ${q(displayName)}, ${q(role)}, ${q(hash)})\n` +
    `ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, active = true;\n`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
