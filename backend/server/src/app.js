// Assembles the Express application. Kept separate from server.js so the
// tests can build an app around their own pools.
"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const compression = require("compression");
const { optionalAuth } = require("./auth");
const { errorHandler } = require("./errors");
const { publicRoutes } = require("./routes/public");
const { authRoutes } = require("./routes/auth");
const { clerkRoutes } = require("./routes/clerk");

function createApp({ publicPool, apiPool, config, log = true }) {
  const app = express();
  app.locals.config = config;
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");

  // Request id: ties a 500 the user sees to the line in the server log.
  app.use((req, res, next) => {
    req.id = crypto.randomUUID().slice(0, 8);
    res.set("X-Request-Id", req.id);
    if (log) {
      const t0 = process.hrtime.bigint();
      res.on("finish", () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms [${req.id}]`);
      });
    }
    next();
  });

  // Basic security headers. The CSP allows Leaflet from unpkg and the
  // OpenStreetMap tiles; nothing else is loaded from anywhere.
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      // OpenStreetMap refuses tile requests that carry no Referer, so
      // other sites receive the origin only (never the full page address).
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' https://unpkg.com",
        "style-src 'self' https://unpkg.com 'unsafe-inline'",
        "img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://unpkg.com",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    });
    next();
  });

  // gzip: GeoJSON compresses roughly five-fold, and every kilobyte is paid
  // for by someone on a metered bundle.
  app.use(compression());

  // CORS: only needed when the client is served from a different origin
  // (for example VS Code Live Server on :5500). Allowed origins are listed
  // in CORS_ORIGINS; everything else is refused by the browser.
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && config.corsOrigins.includes(origin)) {
      res.set({
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
        "Access-Control-Expose-Headers": "Location, X-Request-Id",
      });
      if (req.method === "OPTIONS") return res.sendStatus(204);
    }
    next();
  });

  const api = express.Router();
  api.use(express.json({ limit: "50kb" }));
  api.use(optionalAuth(config.tokenSecret));
  api.use(authRoutes({ apiPool, config }));
  api.use(clerkRoutes({ apiPool, config }));
  api.use(publicRoutes({ publicPool, apiPool, config }));
  api.use((req, res) => res.status(404).json({ code: "not-found", description: `Nothing at ${req.originalUrl}.` }));
  app.use("/api", api);

  // The map client (Frontend/client), served from the same origin as the API (no CORS needed).
  app.use(express.static(path.join(__dirname, "..", "..", "..", "Frontend", "client"), { maxAge: "1h", index: "index.html" }));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
