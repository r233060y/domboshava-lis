// Small helpers for validating input at the boundary (Manual §5.3.4)
// and answering honestly with the right status code (§5.2).
"use strict";

const UPI_RE = /^GRD-W[0-9]{1,2}[A-Z]{3}-[0-9]{5}$/;
const VILLAGE_RE = /^[A-Z]{3}$/;
const PARTY_CODE_RE = /^P-[0-9]{5}$/;
const LEVY_ACCOUNT_RE = /^GRDC-L-[0-9]{5}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const STATUSES = ["RECOGNISED", "CUSTOMARY_ONLY", "UNRECOGNISED_CLAIM", "DISPUTED", "NO_RIGHT"];

// OGC API exception shape: { code, description }
function fail(res, status, code, description, extra = {}) {
  return res.status(status).json({ code, description, ...extra });
}

// Clamp, never trust: ?limit=99999999 must not serialise the register.
function asInt(v, dflt, min, max) {
  if (v === undefined || v === "") return dflt;
  if (!/^-?\d+$/.test(String(v))) return null;
  const n = Number(v);
  return Math.min(max, Math.max(min, n));
}

// bbox = minLon,minLat,maxLon,maxLat in WGS 84 (CRS84). Four numbers,
// ordered, in range — or null.
function parseBbox(s) {
  if (typeof s !== "string") return null;
  const parts = s.split(",");
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (/^\s*-?\d+(\.\d+)?\s*$/.test(p) ? Number(p) : NaN));
  if (n.some(Number.isNaN)) return null;
  const [minX, minY, maxX, maxY] = n;
  if (minX < -180 || maxX > 180 || minY < -90 || maxY > 90) return null;
  if (minX >= maxX || minY >= maxY) return null;
  return n;
}

function isIsoDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Absolute URL for links in OGC responses, honouring a reverse proxy.
function baseUrl(req) {
  return `${req.protocol}://${req.get("host")}${req.baseUrl}`;
}

module.exports = {
  UPI_RE, VILLAGE_RE, PARTY_CODE_RE, LEVY_ACCOUNT_RE, STATUSES,
  fail, asInt, parseBbox, isIsoDate, baseUrl,
};
