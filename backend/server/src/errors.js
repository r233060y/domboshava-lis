// Error handling that does not take the server down and does not leak
// the SQL, the stack or the connection string (Manual §5.3.5).
// Database errors are translated into honest status codes with messages
// a clerk can act on; everything else is a generic 500 carrying a
// request id that matches the server log.
"use strict";

const FRIENDLY_CONSTRAINTS = {
  rrr_one_grdc_right_per_parcel:
    "The council has already consented to a current right on this homestead. End that right first (mode \"replace\").",
  party_rrr_pkey: "The same person is listed twice as a holder of this right.",
  rrr_check: "A right cannot end before it starts.",
  rrr_rrr_type_rrr_kind_fkey: "That right type does not exist.",
  party_rrr_check: "A share cannot be more than one whole (numerator above denominator).",
  source_document_doc_type_fkey: "That document type does not exist.",
  parcel_boundary_quality_fkey: "That boundary quality code does not exist.",
  parcel_land_use_check: "Land use must be RESIDENTIAL, AGRICULTURE or MIXED.",
};

function translatePgError(err) {
  if (!err || typeof err.code !== "string") return null;
  const friendly = FRIENDLY_CONSTRAINTS[err.constraint];
  switch (err.code) {
    case "23505": return { status: 409, code: "conflict", description: friendly || "A record with these details already exists." };
    case "23514": return { status: 422, code: "invalid", description: friendly || "A value is outside what the register allows." };
    case "23503": return { status: 422, code: "invalid", description: friendly || "A code in this request does not exist in the register." };
    case "23502": return { status: 422, code: "invalid", description: "A required value is missing." };
    case "22001": return { status: 422, code: "invalid", description: "A value is too long." };
    case "22007":
    case "22008": return { status: 400, code: "bad-request", description: "A date is not valid. Use YYYY-MM-DD." };
    case "22P02": return { status: 400, code: "bad-request", description: "A value has the wrong format." };
    // RAISE EXCEPTION from our own triggers: messages written for people
    case "P0001": return { status: 422, code: "invalid", description: err.message };
    case "42501": return { status: 403, code: "forbidden", description: "The register does not permit this action." };
    case "57P01": case "57P03": case "08000": case "08001": case "08003": case "08006":
      return { status: 503, code: "service-unavailable", description: "The register database cannot be reached. Try again shortly." };
    default: return null;
  }
}

function isConnectionError(err) {
  return ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH"].includes(err && err.code)
    || /Connection terminated|timeout exceeded when trying to connect/i.test((err && err.message) || "");
}

// Express error middleware (four arguments).
function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ code: "bad-request", description: "The request body is not valid JSON." });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ code: "too-large", description: "The request body is too large." });
  }
  const t = translatePgError(err)
    || (isConnectionError(err) && { status: 503, code: "service-unavailable",
         description: "The register database cannot be reached. Try again shortly." });
  if (t) {
    if (t.status >= 500) console.error(`[${req.id}] ${t.code}:`, err.message);
    return res.status(t.status).json({ code: t.code, description: t.description });
  }
  console.error(`[${req.id}] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({
    code: "internal",
    description: "Something went wrong on the server. Quote this reference if you report it.",
    requestId: req.id,
  });
}

module.exports = { errorHandler, translatePgError };
