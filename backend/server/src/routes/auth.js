// POST /auth/login: a clerk signs in and receives a short-lived token.
"use strict";
const express = require("express");
const { fail } = require("../http");
const { verifyPassword, getDummyHash, signToken, loginLimiter } = require("../auth");

function authRoutes({ apiPool, config }) {
  const r = express.Router();
  const limiter = loginLimiter();

  r.post("/auth/login", async (req, res, next) => {
    try {
      const ip = req.ip;
      if (limiter.blocked(ip)) {
        return fail(res, 429, "too-many-attempts", "Too many failed sign-ins. Wait 15 minutes and try again.");
      }
      const { username, password } = req.body || {};
      if (typeof username !== "string" || typeof password !== "string" || !username || !password || password.length > 200) {
        return fail(res, 400, "bad-request", "Enter your username and password.");
      }
      const { rows } = await apiPool.query(
        "SELECT username, display_name, role, password_hash, active FROM lis.app_user WHERE username = $1",
        [username.trim().toLowerCase()]);
      const u = rows[0];
      const ok = await verifyPassword(password, u ? u.password_hash : await getDummyHash());
      if (!u || !ok || !u.active) {
        limiter.fail(ip);
        return fail(res, 401, "unauthenticated", "That username and password do not match an active account.");
      }
      limiter.reset(ip);
      const { token, expiresAt } = signToken(config.tokenSecret,
        { sub: u.username, role: u.role }, config.tokenTtlHours);
      res.json({ token, expiresAt, user: { username: u.username, displayName: u.display_name, role: u.role } });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { authRoutes };
