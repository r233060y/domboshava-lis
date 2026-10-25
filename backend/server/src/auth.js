// Authentication: scrypt password hashes and short-lived signed tokens.
// Only Node's built-in crypto is used, so there is no extra dependency
// to audit. Tokens are signed, not encrypted: they carry the username
// and role, never personal data.
"use strict";
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { fail } = require("./http");

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length,
                           { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(key, expected);
}

// A dummy hash so a login for an unknown user takes as long as one for
// a known user (no username probing by timing).
let dummyHash;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(12).toString("hex"));
  return dummyHash;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function signToken(secret, payload, ttlHours) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + Math.round(ttlHours * 3600) };
  const data = b64url(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return { token: `${data}.${sig}`, expiresAt: new Date(body.exp * 1000).toISOString() };
}

function verifyToken(secret, token) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(data).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(data, "base64url").toString("utf8")); } catch { return null; }
  if (!body || typeof body.sub !== "string" || typeof body.exp !== "number") return null;
  if (body.exp < Date.now() / 1000) return null;
  return body;
}

// Reads a Bearer token if present. Anonymous requests are allowed
// through: the public routes decide what an anonymous caller sees.
function optionalAuth(secret) {
  return (req, _res, next) => {
    const h = req.get("authorization") || "";
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    req.user = m ? verifyToken(secret, m[1]) : null;
    req.authAttempted = Boolean(m);
    next();
  };
}

// Role check on every write and every personal-data route (Manual §7.4).
// The account is re-checked in the database, so disabling a clerk takes
// effect immediately rather than when the token expires.
function requireRole(apiPool, ...roles) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return fail(res, 401, "unauthenticated",
          req.authAttempted ? "Your sign-in has expired. Sign in again." : "Sign in as a council clerk to do this.");
      }
      const { rows } = await apiPool.query(
        "SELECT role, active FROM lis.app_user WHERE username = $1", [req.user.sub]);
      if (!rows.length || !rows[0].active) {
        return fail(res, 401, "unauthenticated", "This account is no longer active.");
      }
      if (!roles.includes(rows[0].role)) {
        return fail(res, 403, "forbidden", "Your account is not permitted to do this.");
      }
      req.user.role = rows[0].role;
      next();
    } catch (e) {
      next(e);
    }
  };
}

// Brute-force brake for /auth/login: 5 failures per IP per 15 minutes.
function loginLimiter() {
  const failures = new Map();
  const WINDOW = 15 * 60 * 1000, MAX = 5;
  return {
    blocked(ip) {
      const f = failures.get(ip);
      if (!f) return false;
      if (Date.now() - f.first > WINDOW) { failures.delete(ip); return false; }
      return f.count >= MAX;
    },
    fail(ip) {
      const f = failures.get(ip);
      if (!f || Date.now() - f.first > WINDOW) failures.set(ip, { first: Date.now(), count: 1 });
      else f.count += 1;
    },
    reset(ip) { failures.delete(ip); },
  };
}

module.exports = {
  hashPassword, verifyPassword, getDummyHash,
  signToken, verifyToken, optionalAuth, requireRole, loginLimiter,
};
