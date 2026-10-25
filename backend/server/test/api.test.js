// API test suite: node --test   (or: npm test)
//
// Runs against a real PostGIS database built from db/01–03. Use a
// separate test database: some tests write (and the register keeps
// history, so nothing they write is ever deleted).
//
//   Settings come from backend/server/.env.test if it exists, else backend/server/.env.
//   Clerk tests need TEST_CLERK_USER and TEST_CLERK_PASSWORD for a clerk
//   created with scripts/create-user.js; without them they are skipped.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const envTest = path.join(__dirname, "..", ".env.test");
if (fs.existsSync(envTest)) require("dotenv").config({ path: envTest, override: true, quiet: true });

const { load } = require("../src/config");
const { createPools } = require("../src/db");
const { createApp } = require("../src/app");

const config = load();
const { publicPool, apiPool } = createPools(config);
let server, base, token;
const CLERK = process.env.TEST_CLERK_USER;
const CLERK_PW = process.env.TEST_CLERK_PASSWORD;

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

before(async () => {
  server = await listen(createApp({ publicPool, apiPool, config, log: false }));
  base = `http://127.0.0.1:${server.address().port}/api`;
  if (CLERK && CLERK_PW) {
    const r = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: CLERK, password: CLERK_PW }),
    });
    assert.equal(r.status, 200, "TEST_CLERK_USER could not sign in");
    token = (await r.json()).token;
  }
});

after(async () => {
  server.close();
  await Promise.allSettled([publicPool.end(), apiPool.end()]);
});

const auth = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const clerkOnly = () => (CLERK && CLERK_PW ? false : "set TEST_CLERK_USER and TEST_CLERK_PASSWORD to run");

// ---------------------------------------------------------------------
// The three tests the lab asks for (Manual §5.5)
// ---------------------------------------------------------------------
test("a valid bbox request returns a GeoJSON FeatureCollection in lon/lat order", async () => {
  const r = await fetch(`${base}/collections/homesteads/items?bbox=31.13,-17.64,31.17,-17.59&limit=5`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /application\/geo\+json/);
  const fc = await r.json();
  assert.equal(fc.type, "FeatureCollection");
  assert.ok(fc.numberMatched >= 50, "the check-in needs at least 50 homesteads");
  assert.equal(fc.numberReturned, 5);
  assert.ok(fc.links.some((l) => l.rel === "next"), "a next link when more remain");
  const [lon, lat] = fc.features[0].geometry.coordinates[0][0];
  assert.ok(lon > 31 && lon < 31.3, `longitude first (got ${lon})`);
  assert.ok(lat < -17.5 && lat > -17.7, `latitude second (got ${lat})`);
  // 7 decimal places at most (about 1 cm): no wasted bytes
  assert.ok(String(lon).split(".")[1].length <= 7);
});

test("an invalid bbox is refused with 400", async () => {
  for (const bbox of ["1,2,3", "31.2,-17.6,31.1,-17.5", "a,b,c,d", "200,-17,201,-16"]) {
    const r = await fetch(`${base}/collections/homesteads/items?bbox=${encodeURIComponent(bbox)}`);
    assert.equal(r.status, 400, `bbox ${bbox}`);
    const body = await r.json();
    assert.equal(body.code, "bad-request");
  }
});

test("an injection attempt matches nothing and the table survives", async () => {
  const before = (await publicPool.query("SELECT count(*)::int AS n FROM lis.parcel_public")).rows[0].n;
  const attacks = [
    `/collections/homesteads/items?village=${encodeURIComponent("x'; DROP TABLE lis.parcel; --")}`,
    `/collections/homesteads/items?status=${encodeURIComponent("RECOGNISED') OR 1=1 --")}`,
    `/check?upi=${encodeURIComponent("' OR '1'='1")}`,
    `/collections/homesteads/items/${encodeURIComponent("GRD-W4GUK-00001' OR '1'='1")}`,
  ];
  for (const a of attacks) {
    const r = await fetch(base + a);
    assert.ok([400, 404].includes(r.status), `${a} -> ${r.status}`);
  }
  const after = (await publicPool.query("SELECT count(*)::int AS n FROM lis.parcel_public")).rows[0].n;
  assert.equal(after, before);
});

// ---------------------------------------------------------------------
// Honest status codes and the OGC layout
// ---------------------------------------------------------------------
test("landing page, conformance and collections follow OGC API - Features", async () => {
  const land = await (await fetch(`${base}/`)).json();
  assert.ok(land.links.some((l) => l.rel === "data"));
  const conf = await (await fetch(`${base}/conformance`)).json();
  assert.ok(conf.conformsTo.some((c) => c.endsWith("/conf/core")));
  const cols = await (await fetch(`${base}/collections`)).json();
  assert.deepEqual(cols.collections.map((c) => c.id).sort(), ["homesteads", "villages"]);
  assert.equal(cols.collections[0].extent.spatial.bbox[0].length, 4);
});

test("an unknown homestead is a 404, not a 200 with an error inside", async () => {
  const r = await fetch(`${base}/collections/homesteads/items/GRD-W4GUK-09999`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, "not-found");
  const r2 = await fetch(`${base}/no/such/route`);
  assert.equal(r2.status, 404);
});

test("limit is clamped to 500 and bad numbers are refused", async () => {
  const r = await fetch(`${base}/collections/homesteads/items?limit=99999999`);
  assert.equal(r.status, 200);
  assert.ok((await r.json()).numberReturned <= 500);
  assert.equal((await fetch(`${base}/collections/homesteads/items?limit=ten`)).status, 400);
});

test("the stand check answers by village and number, without names", async () => {
  const r = await fetch(`${base}/check?village=GUK&homestead=10`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.upi, "GRD-W4GUK-00010");
  assert.equal(c.status, "DISPUTED");
  assert.ok(c.advice.length > 20);
  assert.ok(c.rights.every((x) => typeof x.holders === "number" && !("parties" in x) && !("name" in x)));
  assert.equal((await fetch(`${base}/check?village=GUK&homestead=999`)).status, 404);
  assert.equal((await fetch(`${base}/check`)).status, 400);
});

test("anonymous callers see that a right exists, but not who holds it", async () => {
  const f = await (await fetch(`${base}/collections/homesteads/items/GRD-W4GUK-00003`)).json();
  assert.equal(f.properties.personalDataShown, false);
  const right = f.properties.rights.find((x) => x.kind === "RIGHT");
  assert.equal(right.parties, null);
  assert.equal(right.partyCount, 2);           // a married couple, 1/2 each
});

test("metadata reports the storage CRS, its caution and quality measures", async () => {
  const m = await (await fetch(`${base}/metadata`)).json();
  const storage = m.referenceSystemInfo.find((x) => x.role === "storage");
  assert.equal(storage.code, "MSU-CLIS:990031");
  assert.match(storage.proj4, /\+lon_0=31/);
  assert.match(storage.caution, /not adequate for cadastral work/);
  assert.equal(typeof m.dataQualityInfo.measures.homesteadsOverlappingANeighbour, "number");
});

test("write and personal-data routes refuse anonymous callers", async () => {
  for (const [method, p] of [["GET", "/clerk/reconciliation"], ["GET", "/clerk/audit"],
                             ["PATCH", "/collections/homesteads/items/GRD-W4GUK-00001"],
                             ["POST", "/collections/homesteads/items/GRD-W4GUK-00001/rights"]]) {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    assert.equal(r.status, 401, `${method} ${p}`);
  }
  const forged = await fetch(`${base}/clerk/reconciliation`, { headers: { Authorization: "Bearer eyJzdWIiOiJhZG1pbiJ9.forged" } });
  assert.equal(forged.status, 401);
});

test("five failed sign-ins lock the address out for a while", async () => {
  const s = await listen(createApp({ publicPool, apiPool, config, log: false }));
  const b = `http://127.0.0.1:${s.address().port}/api`;
  const attempt = () => fetch(`${b}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "nobody.here", password: "wrong-password" }) });
  for (let i = 0; i < 5; i += 1) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
  s.close();
});

// ---------------------------------------------------------------------
// Least privilege, checked in the database itself (Manual §4.6)
// ---------------------------------------------------------------------
test("the API role cannot delete a homestead or rewrite the audit log", async () => {
  await assert.rejects(apiPool.query("DELETE FROM lis.parcel WHERE upi = 'GRD-W4GUK-00001'"), { code: "42501" });
  await assert.rejects(apiPool.query("UPDATE lis.audit_log SET changed_by = 'nobody'"), { code: "42501" });
  await assert.rejects(apiPool.query("DELETE FROM lis.audit_log"), { code: "42501" });
  await assert.rejects(apiPool.query("INSERT INTO lis.app_user VALUES ('x.hacker','x','admin','scrypt$x',true,now())"), { code: "42501" });
});

test("the public role can read the public views and nothing else", async () => {
  await assert.rejects(publicPool.query("SELECT full_name FROM lis.party LIMIT 1"), { code: "42501" });
  await assert.rejects(publicPool.query("SELECT * FROM lis.levy_account LIMIT 1"), { code: "42501" });
  await assert.rejects(publicPool.query("SELECT * FROM lis.app_user LIMIT 1"), { code: "42501" });
  const cols = await publicPool.query("SELECT * FROM lis.parcel_public LIMIT 1");
  const names = cols.fields.map((f) => f.name);
  assert.ok(!names.some((n) => /name|sex|payer|holder/.test(n) && n !== "village"), names.join(","));
});

test("a homestead's UPI cannot be changed, even directly in the database", async () => {
  const c = await apiPool.connect();
  try {
    await c.query("BEGIN");
    await assert.rejects(c.query("UPDATE lis.parcel SET upi = 'GRD-W4GUK-00099' WHERE upi = 'GRD-W4GUK-00001'"),
      /cannot be changed/);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});

// ---------------------------------------------------------------------
// Clerk workflow (needs TEST_CLERK_USER / TEST_CLERK_PASSWORD)
// ---------------------------------------------------------------------
test("a clerk records a joint allocation, and the audit log names the clerk", { skip: clerkOnly() }, async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await fetch(`${base}/collections/homesteads/items/GRD-W4CRD-00006/rights`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({
      mode: "replace", rrrType: "CUSTOMARY_ALLOCATION", recognisedBy: "GRDC", startDate: today,
      holders: [
        { fullName: "Test Husband", sex: "M", role: "HOLDER", shareNum: 1, shareDen: 2 },
        { fullName: "Test Wife", sex: "F", role: "SPOUSE", shareNum: 1, shareDen: 2 },
      ],
      evidence: [{ docType: "RDC_CONSENT", reference: "GRDC/W4/ALLOC/TEST/1", issuedOn: today }],
    }),
  });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  assert.match(r.headers.get("location"), /GRD-W4CRD-00006$/);
  assert.equal((await r.json()).status, "RECOGNISED");

  const f = await (await fetch(`${base}/collections/homesteads/items/GRD-W4CRD-00006`, { headers: auth() })).json();
  const cur = f.properties.rights.find((x) => x.current && x.kind === "RIGHT");
  assert.deepEqual(cur.parties.map((p) => p.share).sort(), ["1/2", "1/2"]);

  const a = await (await fetch(`${base}/clerk/audit?upi=GRD-W4CRD-00006&limit=20`, { headers: auth() })).json();
  assert.ok(a.entries.some((e) => e.by === CLERK && e.table === "rrr" && e.action === "created"));
});

test("shares that do not add up to one whole are refused by the database", { skip: clerkOnly() }, async () => {
  const r = await fetch(`${base}/collections/homesteads/items/GRD-W4CRD-00006/rights`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({
      mode: "replace", rrrType: "CUSTOMARY_ALLOCATION", recognisedBy: "VILLAGE_HEAD",
      startDate: new Date().toISOString().slice(0, 10),
      holders: [{ fullName: "A Person", sex: "M", shareNum: 1, shareDen: 2 },
                { fullName: "B Person", sex: "F", shareNum: 1, shareDen: 3 }],
    }),
  });
  assert.equal(r.status, 422);
  assert.match((await r.json()).description, /add up to/);
});

test("the council cannot consent twice to the same homestead", { skip: clerkOnly() }, async () => {
  const r = await fetch(`${base}/collections/homesteads/items/GRD-W4GUK-00001/rights`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({
      mode: "competing", rrrType: "RDC_PERMIT", recognisedBy: "GRDC",
      startDate: new Date().toISOString().slice(0, 10),
      holders: [{ fullName: "Second Person", sex: "F", shareNum: 1, shareDen: 1 }],
    }),
  });
  assert.equal(r.status, 409);
});

test("PATCH refuses fields outside the allow-list (mass assignment)", { skip: clerkOnly() }, async () => {
  const r = await fetch(`${base}/collections/homesteads/items/GRD-W4GUK-00002`, {
    method: "PATCH", headers: auth(), body: JSON.stringify({ upi: "OTHER-STAND-00001", geom: null }),
  });
  assert.equal(r.status, 422);
  assert.deepEqual((await r.json()).rejected.sort(), ["geom", "upi"]);
  const ok = await fetch(`${base}/collections/homesteads/items/GRD-W4GUK-00002`, {
    method: "PATCH", headers: auth(), body: JSON.stringify({ reconciled: true }),
  });
  assert.equal(ok.status, 200);
});

test("automatic levy matching leaves the messy references for a clerk", { skip: clerkOnly() }, async () => {
  const run = await fetch(`${base}/clerk/reconciliation/levy/run`, { method: "POST", headers: auth() });
  assert.equal(run.status, 200);
  const un = await (await fetch(`${base}/clerk/reconciliation/levy?status=unmatched`, { headers: auth() })).json();
  assert.ok(un.accounts.every((a) => a.normalisedRef === null || !a.upi));
  const sum = await (await fetch(`${base}/clerk/reconciliation`, { headers: auth() })).json();
  assert.ok(sum.totals.levy_match_rate > 0.6 && sum.totals.levy_match_rate < 1);
});

// ---------------------------------------------------------------------
// "What happens if the database is down?" (Manual §7.7)
// ---------------------------------------------------------------------
test("with the database down the API answers 503, and stays up", async () => {
  const down = createPools({ ...config,
    publicDb: { ...config.publicDb, port: 1, connectionTimeoutMillis: 500 },
    apiDb: { ...config.apiDb, port: 1, connectionTimeoutMillis: 500 } });
  const s = await listen(createApp({ ...down, config, log: false }));
  const b = `http://127.0.0.1:${s.address().port}/api`;
  const h = await fetch(`${b}/health`);
  assert.equal(h.status, 503);
  const items = await fetch(`${b}/collections/homesteads/items`);
  assert.equal(items.status, 503);
  const body = await items.json();
  assert.equal(body.code, "service-unavailable");
  assert.ok(!/ECONNREFUSED|127\.0\.0\.1|password/.test(JSON.stringify(body)), "no internals leaked");
  assert.equal((await fetch(`${b}/`)).status, 200, "the process is still serving");
  s.close();
  await Promise.allSettled([down.publicPool.end(), down.apiPool.end()]);
});
