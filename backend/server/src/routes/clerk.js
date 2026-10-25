// Clerk routes: everything that writes, and everything that shows
// personal data. Every route here passes requireRole first, and every
// write runs inside withUser() so the audit log names the clerk.
"use strict";
const express = require("express");
const { withUser } = require("../db");
const { requireRole } = require("../auth");
const { fail, asInt, isIsoDate, UPI_RE, PARTY_CODE_RE, LEVY_ACCOUNT_RE } = require("../http");
const { iso } = require("./public");

// Mass-assignment guard (Manual §7.4): the ONLY fields a PATCH may set.
// upi, geom, village and homestead number are deliberately absent.
const EDITABLE = {
  landUse: "land_use",
  boundaryQuality: "boundary_quality",
  reconciled: "reconciled",
};
const LAND_USES = ["RESIDENTIAL", "AGRICULTURE", "MIXED"];
const RECOGNISED_BY = ["GRDC", "VILLAGE_HEAD", "NONE"];
const ROLES = ["HOLDER", "SPOUSE", "HEIR", "CLAIMANT"];
const MODES = ["new", "replace", "competing"];

function clerkRoutes({ apiPool }) {
  const r = express.Router();
  const clerk = requireRole(apiPool, "clerk", "admin");

  // ---- Amend a homestead's attributes --------------------------------
  r.patch("/collections/homesteads/items/:upi", clerk, async (req, res, next) => {
    try {
      const upi = req.params.upi.toUpperCase();
      if (!UPI_RE.test(upi)) return fail(res, 404, "not-found", `No homestead ${req.params.upi} is on the register.`);
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length) {
        return fail(res, 400, "bad-request", "Send a JSON object with the fields to change.");
      }
      const rejected = Object.keys(body).filter((k) => !(k in EDITABLE));
      if (rejected.length) {
        return fail(res, 422, "not-editable",
          `These fields cannot be changed through the API: ${rejected.join(", ")}. Editable fields: ${Object.keys(EDITABLE).join(", ")}.`,
          { rejected });
      }
      if ("landUse" in body && !LAND_USES.includes(body.landUse)) {
        return fail(res, 422, "invalid", `landUse must be one of ${LAND_USES.join(", ")}.`);
      }
      if ("reconciled" in body && typeof body.reconciled !== "boolean") {
        return fail(res, 422, "invalid", "reconciled must be true or false.");
      }
      if ("boundaryQuality" in body && typeof body.boundaryQuality !== "string") {
        return fail(res, 422, "invalid", "boundaryQuality must be a code such as GNSS_HANDHELD.");
      }
      const sets = [], params = [upi];
      for (const [k, col] of Object.entries(EDITABLE)) {
        if (k in body) { params.push(body[k]); sets.push(`${col} = $${params.length}`); }
      }
      const row = await withUser(apiPool, req.user.sub, async (c) => {
        const u = await c.query(
          `UPDATE lis.parcel SET ${sets.join(", ")} WHERE upi = $1
           RETURNING upi, land_use, boundary_quality, reconciled, updated_at`, params);
        return u.rows[0];
      });
      if (!row) return fail(res, 404, "not-found", `No homestead ${upi} is on the register.`);
      res.json({
        upi: row.upi, landUse: row.land_use, boundaryQuality: row.boundary_quality,
        reconciled: row.reconciled, updatedAt: row.updated_at,
      });
    } catch (e) { next(e); }
  });

  // ---- Record an allocation (or any right) on a homestead -------------
  // mode "new":       refuse if the homestead already has a current right
  // mode "replace":   end every current right on startDate, then record this one
  // mode "competing": record alongside existing claims (a dispute, as found).
  //                   The database still refuses a second GRDC-recognised right.
  r.post("/collections/homesteads/items/:upi/rights", clerk, async (req, res, next) => {
    try {
      const upi = req.params.upi.toUpperCase();
      if (!UPI_RE.test(upi)) return fail(res, 404, "not-found", `No homestead ${req.params.upi} is on the register.`);
      const b = req.body || {};
      const mode = b.mode === undefined ? "new" : b.mode;
      const problems = [];
      if (typeof b.rrrType !== "string") problems.push("rrrType is required (for example CUSTOMARY_ALLOCATION).");
      if (!RECOGNISED_BY.includes(b.recognisedBy)) problems.push(`recognisedBy must be one of ${RECOGNISED_BY.join(", ")}.`);
      if (!isIsoDate(b.startDate)) problems.push("startDate must be a date in the form YYYY-MM-DD.");
      else if (b.startDate > new Date().toISOString().slice(0, 10)) problems.push("startDate cannot be in the future.");
      if (!MODES.includes(mode)) problems.push(`mode must be one of ${MODES.join(", ")}.`);
      if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) problems.push("note must be text of 500 characters or fewer.");
      if (!Array.isArray(b.holders) || b.holders.length < 1 || b.holders.length > 10) {
        problems.push("holders must list between 1 and 10 people.");
      } else {
        b.holders.forEach((h, i) => {
          const n = i + 1;
          if (!h || typeof h !== "object") { problems.push(`Holder ${n} is not valid.`); return; }
          if (h.partyCode !== undefined) {
            if (!PARTY_CODE_RE.test(h.partyCode)) problems.push(`Holder ${n}: partyCode must look like P-00012.`);
          } else {
            if (typeof h.fullName !== "string" || h.fullName.trim().length < 2 || h.fullName.length > 120) problems.push(`Holder ${n}: enter the full name.`);
            if (!["F", "M"].includes(h.sex)) problems.push(`Holder ${n}: sex must be F or M.`);
          }
          if (!ROLES.includes(h.role || "HOLDER")) problems.push(`Holder ${n}: role must be one of ${ROLES.join(", ")}.`);
          for (const f of ["shareNum", "shareDen"]) {
            if (!Number.isInteger(h[f]) || h[f] < 1 || h[f] > 1000) problems.push(`Holder ${n}: ${f} must be a whole number from 1 to 1000.`);
          }
        });
      }
      const evidence = b.evidence === undefined ? [] : b.evidence;
      if (!Array.isArray(evidence) || evidence.length > 5) {
        problems.push("evidence must be a list of at most 5 documents.");
      } else {
        evidence.forEach((d, i) => {
          if (!d || typeof d.docType !== "string") problems.push(`Document ${i + 1}: docType is required.`);
          if (!d || typeof d.reference !== "string" || d.reference.trim().length < 3 || d.reference.length > 200) problems.push(`Document ${i + 1}: reference must be 3–200 characters.`);
          if (d && d.issuedOn !== undefined && d.issuedOn !== null && !isIsoDate(d.issuedOn)) problems.push(`Document ${i + 1}: issuedOn must be YYYY-MM-DD.`);
        });
      }
      if (problems.length) return fail(res, 422, "invalid", problems[0], { problems });

      const result = await withUser(apiPool, req.user.sub, async (c) => {
        const p = await c.query(
          "SELECT parcel_id, village_id FROM lis.parcel WHERE upi = $1 FOR UPDATE", [upi]);
        if (!p.rows.length) return { status: 404 };
        const { parcel_id: parcelId, village_id: villageId } = p.rows[0];

        const t = await c.query("SELECT rrr_kind FROM lis_ref.rrr_type WHERE code = $1", [b.rrrType]);
        if (!t.rows.length || t.rows[0].rrr_kind !== "RIGHT") return { status: 422, description: "rrrType must be a type of right, such as CUSTOMARY_ALLOCATION." };

        const cur = await c.query(
          "SELECT count(*)::int AS n FROM lis.rrr WHERE parcel_id = $1 AND rrr_kind = 'RIGHT' AND end_date IS NULL",
          [parcelId]);
        if (mode === "new" && cur.rows[0].n > 0) {
          return { status: 409, description: `This homestead already has ${cur.rows[0].n} current right(s). Choose "replace" to end them, or "competing" to record a dispute.` };
        }
        let closed = 0;
        if (mode === "replace") {
          const u = await c.query(
            `UPDATE lis.rrr SET end_date = $2::date
              WHERE parcel_id = $1 AND rrr_kind = 'RIGHT' AND end_date IS NULL`,
            [parcelId, b.startDate]);
          closed = u.rowCount;
        }

        const ins = await c.query(
          `INSERT INTO lis.rrr (parcel_id, rrr_kind, rrr_type, recognised_by, start_date, note)
           VALUES ($1, 'RIGHT', $2, $3, $4::date, $5) RETURNING rrr_id`,
          [parcelId, b.rrrType, b.recognisedBy, b.startDate, b.note || null]);
        const rrrId = ins.rows[0].rrr_id;

        for (const h of b.holders) {
          let partyId;
          if (h.partyCode) {
            const q = await c.query("SELECT party_id FROM lis.party WHERE party_code = $1", [h.partyCode]);
            if (!q.rows.length) throw Object.assign(new Error(`No person with code ${h.partyCode} is on the register.`), { code: "P0001" });
            partyId = q.rows[0].party_id;
          } else {
            const q = await c.query(
              `INSERT INTO lis.party (party_type, full_name, sex, village_id)
               VALUES ('PERSON', $1, $2, $3) RETURNING party_id`,
              [h.fullName.trim(), h.sex, villageId]);
            partyId = q.rows[0].party_id;
          }
          await c.query(
            `INSERT INTO lis.party_rrr (rrr_id, party_id, share_num, share_den, role)
             VALUES ($1, $2, $3, $4, $5)`,
            [rrrId, partyId, h.shareNum, h.shareDen, h.role || "HOLDER"]);
        }

        for (const d of evidence) {
          const q = await c.query(
            `INSERT INTO lis.source_document (doc_type, reference, issued_on, village_id, captured_by)
             VALUES ($1, $2, $3::date, $4, $5) RETURNING doc_id`,
            [d.docType, d.reference.trim(), d.issuedOn || null, villageId, req.user.sub]);
          await c.query("INSERT INTO lis.rrr_source (rrr_id, doc_id) VALUES ($1, $2)", [rrrId, q.rows[0].doc_id]);
        }
        return { status: 201, rrrId, closed };
      });
      // the share-sum rule is checked at COMMIT, inside withUser: if it
      // failed we never reach here (the error handler answers 422)

      if (result.status === 404) return fail(res, 404, "not-found", `No homestead ${upi} is on the register.`);
      if (result.status !== 201) return fail(res, result.status, result.status === 409 ? "conflict" : "invalid", result.description);

      const s = await apiPool.query(
        "SELECT status FROM lis.parcel_status s JOIN lis.parcel p USING (parcel_id) WHERE p.upi = $1", [upi]);
      const location = `${req.baseUrl}/collections/homesteads/items/${upi}`;
      res.status(201).location(location).json({
        rrrId: result.rrrId, upi, rightsEnded: result.closed, status: s.rows[0].status, href: location,
      });
    } catch (e) { next(e); }
  });

  // ---- Reconciliation -------------------------------------------------
  r.get("/clerk/reconciliation", clerk, async (_req, res, next) => {
    try {
      const { rows } = await apiPool.query("SELECT * FROM lis.reconciliation_summary ORDER BY village");
      const villages = rows.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v])));
      const totals = {};
      for (const v of villages) for (const [k, val] of Object.entries(v)) if (typeof val === "number") totals[k] = (totals[k] || 0) + val;
      totals.levy_match_rate = totals.levy_accounts ? Number((totals.levy_matched / totals.levy_accounts).toFixed(3)) : null;
      res.json({ villages, totals });
    } catch (e) { next(e); }
  });

  r.post("/clerk/reconciliation/levy/run", clerk, async (req, res, next) => {
    try {
      const matched = await withUser(apiPool, req.user.sub, async (c) => {
        const q = await c.query("SELECT lis.reconcile_levy_exact() AS n");
        return q.rows[0].n;
      });
      res.json({ matched });
    } catch (e) { next(e); }
  });

  r.get("/clerk/reconciliation/levy", clerk, async (req, res, next) => {
    try {
      const status = req.query.status || "unmatched";
      if (!["unmatched", "matched", "all"].includes(status)) return fail(res, 400, "bad-request", "status must be unmatched, matched or all.");
      const filter = status === "all" ? "" : status === "matched" ? "WHERE l.parcel_id IS NOT NULL" : "WHERE l.parcel_id IS NULL";
      const { rows } = await apiPool.query(`
        SELECT l.account_no, v.name AS village, v.code AS village_code, l.homestead_ref_raw, l.payer_name_raw,
               p.upi, l.match_method, l.matched_on, l.matched_by,
               lis.normalise_homestead_ref(l.homestead_ref_raw) AS normalised_ref
          FROM lis.levy_account l
          LEFT JOIN lis.village v ON v.village_id = l.village_id
          LEFT JOIN lis.parcel p  ON p.parcel_id = l.parcel_id
          ${filter}
         ORDER BY l.account_no`);
      res.json({
        accounts: rows.map((x) => ({
          accountNo: x.account_no, village: x.village, villageCode: x.village_code,
          homesteadRef: x.homestead_ref_raw, normalisedRef: x.normalised_ref, payer: x.payer_name_raw,
          upi: x.upi, matchMethod: x.match_method, matchedOn: iso(x.matched_on), matchedBy: x.matched_by,
        })),
      });
    } catch (e) { next(e); }
  });

  // Manual match: a clerk links an account to a homestead by hand.
  r.patch("/clerk/reconciliation/levy/:account", clerk, async (req, res, next) => {
    try {
      const account = req.params.account.toUpperCase();
      if (!LEVY_ACCOUNT_RE.test(account)) return fail(res, 404, "not-found", "No such levy account.");
      const upi = String((req.body || {}).upi || "").trim().toUpperCase();
      if (!UPI_RE.test(upi)) return fail(res, 422, "invalid", "Enter the homestead number to match, in the form GRD-W4GUK-00012.");
      const out = await withUser(apiPool, req.user.sub, async (c) => {
        const a = await c.query("SELECT parcel_id, village_id FROM lis.levy_account WHERE account_no = $1 FOR UPDATE", [account]);
        if (!a.rows.length) return { status: 404, d: "No such levy account." };
        if (a.rows[0].parcel_id) return { status: 409, d: "This account is already matched to a homestead." };
        const p = await c.query("SELECT parcel_id, village_id FROM lis.parcel WHERE upi = $1", [upi]);
        if (!p.rows.length) return { status: 422, d: `No homestead ${upi} is on the register.` };
        if (a.rows[0].village_id !== null && a.rows[0].village_id !== p.rows[0].village_id) {
          return { status: 422, d: "That homestead is in a different village from the account." };
        }
        await c.query(
          `UPDATE lis.levy_account SET parcel_id = $2, match_method = 'MANUAL',
                  matched_on = current_date, matched_by = $3 WHERE account_no = $1`,
          [account, p.rows[0].parcel_id, req.user.sub]);
        return { status: 200 };
      });
      if (out.status !== 200) return fail(res, out.status, out.status === 409 ? "conflict" : out.status === 404 ? "not-found" : "invalid", out.d);
      res.json({ accountNo: account, upi, matchMethod: "MANUAL" });
    } catch (e) { next(e); }
  });

  r.get("/clerk/reconciliation/unlevied", clerk, async (_req, res, next) => {
    try {
      const { rows } = await apiPool.query(`
        SELECT p.upi, v.name AS village, s.status
          FROM lis.parcel p
          JOIN lis.village v USING (village_id)
          JOIN lis.parcel_status s USING (parcel_id)
         WHERE s.status <> 'NO_RIGHT'
           AND NOT EXISTS (SELECT 1 FROM lis.levy_account l WHERE l.parcel_id = p.parcel_id)
         ORDER BY p.upi`);
      res.json({ homesteads: rows });
    } catch (e) { next(e); }
  });

  r.get("/clerk/reconciliation/book", clerk, async (_req, res, next) => {
    try {
      const { rows } = await apiPool.query(`
        SELECT d.reference, v.name AS village, d.homestead_ref_raw, d.holder_name_raw, d.issued_on
          FROM lis.source_document d
          LEFT JOIN lis.village v USING (village_id)
         WHERE d.doc_type = 'ALLOCATION_BOOK_ENTRY'
           AND NOT EXISTS (SELECT 1 FROM lis.rrr_source rs WHERE rs.doc_id = d.doc_id)
         ORDER BY v.name, d.reference`);
      res.json({ entries: rows.map((x) => ({
        reference: x.reference, village: x.village, homesteadRef: x.homestead_ref_raw,
        holder: x.holder_name_raw, issuedOn: iso(x.issued_on),
      })) });
    } catch (e) { next(e); }
  });

  // ---- Validation (pre-submission check, Manual §7.3) -------------------
  r.get("/clerk/validation", clerk, async (_req, res, next) => {
    try {
      const { rows } = await apiPool.query(`
        SELECT * FROM lis.parcel_validation
         WHERE invalid_geometry OR overlaps_neighbour OR outside_village OR no_current_right
            OR competing_rights OR right_without_evidence OR right_without_holder
         ORDER BY upi`);
      const reasons = {
        invalid_geometry: "Boundary is not a valid polygon",
        overlaps_neighbour: "Overlaps a neighbouring homestead",
        outside_village: "Lies outside its village",
        no_current_right: "No right recorded",
        competing_rights: "More than one current claim",
        right_without_evidence: "A current right has no evidence on file",
        right_without_holder: "A current right has no holder",
      };
      res.json({
        homesteads: rows.map((x) => ({
          upi: x.upi, village: x.village,
          issues: Object.keys(reasons).filter((k) => x[k]).map((k) => (
            k === "overlaps_neighbour" ? `${reasons[k]} (${x.overlapping_upis})` : reasons[k])),
        })),
      });
    } catch (e) { next(e); }
  });

  // ---- Audit trail ------------------------------------------------------
  r.get("/clerk/audit", clerk, async (req, res, next) => {
    try {
      const limit = asInt(req.query.limit, 50, 1, 200);
      if (limit === null) return fail(res, 400, "bad-request", "limit must be a whole number.");
      const params = [limit];
      let filter = "WHERE changed_by NOT LIKE 'seed:%'";
      if (req.query.upi !== undefined) {
        const upi = String(req.query.upi).toUpperCase();
        if (!UPI_RE.test(upi)) return fail(res, 400, "bad-request", "Invalid homestead number.");
        params.push(upi);
        filter = `WHERE record_pk IN (
                    SELECT parcel_id::text FROM lis.parcel WHERE upi = $2
                    UNION SELECT r.rrr_id::text FROM lis.rrr r JOIN lis.parcel p USING (parcel_id) WHERE p.upi = $2)
                     OR (table_name = 'party_rrr' AND split_part(record_pk, '|', 1) IN (
                        SELECT r.rrr_id::text FROM lis.rrr r JOIN lis.parcel p USING (parcel_id) WHERE p.upi = $2))`;
      }
      const { rows } = await apiPool.query(`
        SELECT changed_at, changed_by, table_name, action, changed_cols
          FROM lis.audit_log ${filter}
         ORDER BY audit_id DESC LIMIT $1`, params);
      res.json({ entries: rows.map((x) => ({
        at: x.changed_at, by: x.changed_by, table: x.table_name,
        action: { I: "created", U: "changed", D: "removed" }[x.action], fields: x.changed_cols,
      })) });
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { clerkRoutes };
