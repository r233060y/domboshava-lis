// Public routes: the OGC API — Features layout (Manual §5.2.1), the
// stand check and the metadata record. Anonymous requests read ONLY the
// public views, through the lis_public pool, so no personal column is
// reachable from here. An authenticated clerk additionally sees holders.
"use strict";
const express = require("express");
const { fail, asInt, parseBbox, baseUrl, UPI_RE, VILLAGE_RE, STATUSES } = require("../http");

const STATUS_TEXT = {
  RECOGNISED: {
    label: "Council-recognised",
    advice: "The council has consented to a right over this homestead. It cannot be allocated again unless that right is ended.",
  },
  CUSTOMARY_ONLY: {
    label: "Allocated by the village head only",
    advice: "The village head has allocated this homestead, but the council's consent is not on record. Ask the Goromonzi RDC office before paying anyone for it.",
  },
  UNRECOGNISED_CLAIM: {
    label: "Claim without a lawful basis",
    advice: "Someone claims this homestead without a lawful basis on record, such as an informal purchase. Communal land cannot lawfully be sold.",
  },
  DISPUTED: {
    label: "Disputed",
    advice: "More than one person claims this homestead. Do not pay for it until the council resolves the dispute.",
  },
  NO_RIGHT: {
    label: "No right recorded",
    advice: "No right is recorded for this homestead. It may still be occupied: ask the council before acting.",
  },
};

// GeoJSON is built in the database (Manual §5.3.2). ST_Transform(geom, 4326)
// appears here and nowhere else: storage is Lo 31, output is WGS 84,
// lon/lat order (RFC 7946), 7 decimals (about 1 cm).
// The SRID is written into the SQL text, never bound as a parameter (§5.3.3).
const FEATURE_SQL = `
  jsonb_build_object(
    'type', 'Feature',
    'id', upi,
    'geometry', ST_AsGeoJSON(ST_Transform(geom, 4326), 7)::jsonb,
    'properties', jsonb_build_object(
      'upi', upi,
      'village', village,
      'villageCode', village_code,
      'ward', ward,
      'homesteadNo', homestead_no,
      'landUse', land_use,
      'boundaryQuality', boundary_quality,
      'areaM2', area_m2,
      'status', status,
      'currentRights', current_rights,
      'currentRestrictions', current_restrictions,
      'updatedAt', updated_at))`;

function publicRoutes({ publicPool, apiPool }) {
  const r = express.Router();

  // ---- Landing page -------------------------------------------------
  r.get("/", (req, res) => {
    const base = baseUrl(req);
    res.json({
      title: "Domboshava Ward 4 Homestead Register",
      description: "Homesteads, customary allocations and council-recognised rights in five villages of Ward 4, Goromonzi Rural District. Synthetic demonstration data. Boundaries are indicative and carry no legal weight.",
      links: [
        { href: `${base}/`, rel: "self", type: "application/json", title: "This document" },
        { href: `${base}/conformance`, rel: "conformance", type: "application/json", title: "Conformance classes" },
        { href: `${base}/collections`, rel: "data", type: "application/json", title: "Collections" },
        { href: `${base}/metadata`, rel: "describedby", type: "application/json", title: "Metadata record (ISO 19115 elements)" },
        { href: `${base}/check{?upi,village,homestead}`, rel: "search", type: "application/json", title: "Public stand check", templated: true },
      ],
    });
  });

  r.get("/conformance", (_req, res) => {
    res.json({
      conformsTo: [
        "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
        "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
      ],
    });
  });

  // ---- Collections --------------------------------------------------
  async function extent() {
    const { rows } = await publicPool.query(`
      SELECT ST_XMin(e) AS minx, ST_YMin(e) AS miny, ST_XMax(e) AS maxx, ST_YMax(e) AS maxy
        FROM (SELECT ST_Extent(ST_Transform(geom, 4326)) AS e FROM lis.village_public) s`);
    const b = rows[0];
    return b && b.minx !== null ? [[b.minx, b.miny, b.maxx, b.maxy].map((n) => Number(n.toFixed(6)))] : [];
  }

  function describe(req, id, bbox) {
    const base = baseUrl(req);
    const titles = {
      homesteads: ["Homesteads", "One polygon per homestead, with its current status. No personal data."],
      villages: ["Villages", "Extents of the five sampled villages (illustrative)."],
    };
    return {
      id,
      title: titles[id][0],
      description: titles[id][1],
      itemType: "feature",
      crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
      extent: { spatial: { bbox, crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } },
      links: [
        { href: `${base}/collections/${id}`, rel: "self", type: "application/json" },
        { href: `${base}/collections/${id}/items`, rel: "items", type: "application/geo+json" },
      ],
    };
  }

  r.get("/collections", async (req, res, next) => {
    try {
      const bbox = await extent();
      res.json({
        links: [{ href: `${baseUrl(req)}/collections`, rel: "self", type: "application/json" }],
        collections: [describe(req, "homesteads", bbox), describe(req, "villages", bbox)],
      });
    } catch (e) { next(e); }
  });

  r.get("/collections/:cid", async (req, res, next) => {
    try {
      if (!["homesteads", "villages"].includes(req.params.cid)) {
        return fail(res, 404, "not-found", `There is no collection called "${req.params.cid}".`);
      }
      res.json(describe(req, req.params.cid, await extent()));
    } catch (e) { next(e); }
  });

  // ---- Homesteads: a FeatureCollection ------------------------------
  r.get("/collections/homesteads/items", async (req, res, next) => {
    try {
      const where = [];
      const params = [];
      const add = (sql, ...vals) => {
        let s = sql;
        for (const v of vals) { params.push(v); s = s.replace("$$", `$${params.length}`); }
        where.push(s);
      };

      if (req.query.bbox !== undefined) {
        const bbox = parseBbox(req.query.bbox);
        if (!bbox) return fail(res, 400, "bad-request", "Invalid bbox. Use minLon,minLat,maxLon,maxLat in WGS 84, for example 31.13,-17.64,31.17,-17.59.");
        add("geom && ST_Transform(ST_MakeEnvelope($$, $$, $$, $$, 4326), 990031)", ...bbox);
      }
      if (req.query.village !== undefined) {
        const v = String(req.query.village).toUpperCase();
        if (!VILLAGE_RE.test(v)) return fail(res, 400, "bad-request", "Invalid village. Use a three-letter village code such as GUK.");
        add("village_code = $$", v);
      }
      if (req.query.status !== undefined) {
        const list = String(req.query.status).toUpperCase().split(",").map((s) => s.trim());
        if (!list.length || list.some((s) => !STATUSES.includes(s))) {
          return fail(res, 400, "bad-request", `Invalid status. Use one or more of ${STATUSES.join(", ")}.`);
        }
        add("status = ANY($$::text[])", list);
      }
      const limit = asInt(req.query.limit, 100, 1, 500);      // capped at 500, and documented
      const offset = asInt(req.query.offset, 0, 0, 100000);
      if (limit === null || offset === null) return fail(res, 400, "bad-request", "limit and offset must be whole numbers.");

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const count = await publicPool.query(`SELECT count(*)::int AS n FROM lis.parcel_public ${whereSql}`, params);
      const page = await publicPool.query(
        `SELECT ${FEATURE_SQL} AS f FROM lis.parcel_public ${whereSql}
          ORDER BY upi LIMIT $${params.length + 1}::int OFFSET $${params.length + 2}::int`,
        [...params, limit, offset]);

      const matched = count.rows[0].n;
      const features = page.rows.map((row) => row.f);
      const self = new URL(`${baseUrl(req)}/collections/homesteads/items`);
      for (const [k, v] of Object.entries(req.query)) self.searchParams.set(k, String(v));
      const links = [{ href: self.toString(), rel: "self", type: "application/geo+json" }];
      if (offset + features.length < matched) {
        const nx = new URL(self); nx.searchParams.set("offset", String(offset + limit)); nx.searchParams.set("limit", String(limit));
        links.push({ href: nx.toString(), rel: "next", type: "application/geo+json" });
      }
      if (offset > 0) {
        const pv = new URL(self); pv.searchParams.set("offset", String(Math.max(0, offset - limit))); pv.searchParams.set("limit", String(limit));
        links.push({ href: pv.toString(), rel: "prev", type: "application/geo+json" });
      }

      res.type("application/geo+json").json({
        type: "FeatureCollection",
        numberMatched: matched,
        numberReturned: features.length,
        timeStamp: new Date().toISOString(),
        links,
        features,
      });
    } catch (e) { next(e); }
  });

  // ---- One homestead --------------------------------------------------
  r.get("/collections/homesteads/items/:upi", async (req, res, next) => {
    try {
      const upi = req.params.upi.toUpperCase();
      if (!UPI_RE.test(upi)) return fail(res, 404, "not-found", `No homestead ${req.params.upi} is on the register.`);
      const { rows } = await publicPool.query(
        `SELECT ${FEATURE_SQL} AS f FROM lis.parcel_public WHERE upi = $1`, [upi]);
      if (!rows.length) return fail(res, 404, "not-found", `No homestead ${upi} is on the register.`);
      const feature = rows[0].f;
      feature.properties.statusLabel = STATUS_TEXT[feature.properties.status].label;

      if (req.user) {
        // Clerk view: full history with holders and evidence (lis_api pool).
        feature.properties.rights = await clerkRights(apiPool, upi);
        feature.properties.personalDataShown = true;
      } else {
        const rr = await publicPool.query(
          `SELECT rrr_kind, rrr_type, rrr_label, recognised, recognised_by, start_date, party_count, evidence_count
             FROM lis.rrr_public WHERE upi = $1 ORDER BY rrr_kind, start_date`, [upi]);
        feature.properties.rights = rr.rows.map((x) => ({
          kind: x.rrr_kind, type: x.rrr_type, label: x.rrr_label, lawfulBasis: x.recognised,
          recognisedBy: x.recognised_by, startDate: iso(x.start_date), endDate: null,
          partyCount: Number(x.party_count), evidenceCount: Number(x.evidence_count),
          parties: null,       // who holds it is not public (Manual §5.4)
        }));
        feature.properties.personalDataShown = false;
      }
      res.type("application/geo+json").json(feature);
    } catch (e) { next(e); }
  });

  // ---- Villages -------------------------------------------------------
  r.get("/collections/villages/items", async (_req, res, next) => {
    try {
      const { rows } = await publicPool.query(`
        SELECT jsonb_build_object('type','FeatureCollection',
                 'numberMatched', count(*), 'numberReturned', count(*),
                 'features', coalesce(jsonb_agg(jsonb_build_object(
                   'type','Feature','id', code,
                   'geometry', ST_AsGeoJSON(ST_Transform(geom, 4326), 7)::jsonb,
                   'properties', jsonb_build_object('code', code, 'name', name, 'ward', ward,
                                                    'homesteads', homesteads))
                   ORDER BY name), '[]'::jsonb)) AS fc
          FROM lis.village_public`);
      res.type("application/geo+json").json(rows[0].fc);
    } catch (e) { next(e); }
  });

  // ---- Public stand check (Manual §7.4: the cheapest anti-fraud control)
  r.get("/check", async (req, res, next) => {
    try {
      let sql, params;
      if (req.query.upi !== undefined) {
        const upi = String(req.query.upi).trim().toUpperCase();
        if (!UPI_RE.test(upi)) return fail(res, 400, "bad-request", "That is not a homestead number in the form GRD-W4GUK-00012.");
        sql = "upi = $1"; params = [upi];
      } else if (req.query.village !== undefined && req.query.homestead !== undefined) {
        const v = String(req.query.village).toUpperCase();
        const h = asInt(req.query.homestead, null, 1, 99999);
        if (!VILLAGE_RE.test(v) || h === null) return fail(res, 400, "bad-request", "Choose a village and enter the homestead number (digits only).");
        sql = "village_code = $1 AND homestead_no = $2"; params = [v, h];
      } else {
        return fail(res, 400, "bad-request", "Give either upi, or village and homestead.");
      }
      const { rows } = await publicPool.query(
        `SELECT upi, village, village_code, homestead_no, land_use, area_m2, status, current_rights,
                current_restrictions, boundary_quality,
                ST_X(ST_Transform(ST_PointOnSurface(geom), 4326)) AS lon,
                ST_Y(ST_Transform(ST_PointOnSurface(geom), 4326)) AS lat
           FROM lis.parcel_public WHERE ${sql}`, params);
      if (!rows.length) {
        return fail(res, 404, "not-found",
          "That homestead is not on the register. Check the village and number, or ask at the Goromonzi RDC office.");
      }
      const p = rows[0];
      const rr = await publicPool.query(
        `SELECT rrr_kind, rrr_label, recognised, recognised_by, start_date, party_count, evidence_count
           FROM lis.rrr_public WHERE upi = $1 ORDER BY rrr_kind, start_date`, [p.upi]);
      res.json({
        upi: p.upi,
        village: p.village,
        homesteadNo: p.homestead_no,
        status: p.status,
        statusLabel: STATUS_TEXT[p.status].label,
        advice: STATUS_TEXT[p.status].advice,
        rights: rr.rows.filter((x) => x.rrr_kind === "RIGHT").map((x) => ({
          label: x.rrr_label, lawfulBasis: x.recognised, recognisedBy: x.recognised_by,
          since: iso(x.start_date), holders: Number(x.party_count), evidence: Number(x.evidence_count),
        })),
        restrictions: rr.rows.filter((x) => x.rrr_kind === "RESTRICTION").map((x) => ({
          label: x.rrr_label, since: iso(x.start_date),
        })),
        areaM2: Number(p.area_m2),
        boundaryQuality: p.boundary_quality,
        location: { lon: Number(Number(p.lon).toFixed(6)), lat: Number(Number(p.lat).toFixed(6)) },
        notice: "This check is not a title deed and boundaries are indicative. Synthetic demonstration data.",
        checkedAt: new Date().toISOString(),
      });
    } catch (e) { next(e); }
  });

  // ---- Lookups for forms ----------------------------------------------
  r.get("/lookups", async (_req, res, next) => {
    try {
      const [types, docs, bq, villages] = await Promise.all([
        publicPool.query("SELECT code, rrr_kind AS kind, label, recognised FROM lis_ref.rrr_type ORDER BY rrr_kind, label"),
        publicPool.query("SELECT code, label FROM lis_ref.doc_type ORDER BY label"),
        publicPool.query("SELECT code, label FROM lis_ref.boundary_quality ORDER BY code"),
        publicPool.query("SELECT code, name, homesteads::int AS homesteads FROM lis.village_public ORDER BY name"),
      ]);
      res.json({
        rrrTypes: types.rows,
        docTypes: docs.rows,
        boundaryQualities: bq.rows,
        villages: villages.rows,
        statuses: STATUSES.map((s) => ({ code: s, label: STATUS_TEXT[s].label })),
      });
    } catch (e) { next(e); }
  });

  // ---- Metadata (ISO 19115 elements, Week 3) ---------------------------
  // try/catch here is not optional: a /metadata route without one once
  // took the whole reference server down (Manual §5.3.5).
  r.get("/metadata", async (req, res, next) => {
    try {
      const [crs, q, ext] = await Promise.all([
        publicPool.query("SELECT proj4text FROM spatial_ref_sys WHERE srid = 990031"),
        apiPool.query(`
          SELECT (SELECT count(*) FROM lis.parcel)::int                                   AS homesteads,
                 (SELECT count(*) FROM lis.parcel_validation WHERE overlaps_neighbour)::int AS overlapping,
                 (SELECT count(*) FROM lis.parcel_validation WHERE invalid_geometry)::int   AS invalid,
                 (SELECT count(*) FROM lis.parcel_status WHERE status = 'NO_RIGHT')::int     AS no_right,
                 (SELECT count(*) FROM lis.parcel_status WHERE status = 'DISPUTED')::int     AS disputed,
                 (SELECT count(*) FROM lis.levy_account)::int                               AS levy,
                 (SELECT count(*) FROM lis.levy_account WHERE parcel_id IS NOT NULL)::int   AS levy_matched,
                 (SELECT max(updated_at) FROM lis.parcel)                                  AS last_change`),
        extent(),
      ]);
      const m = q.rows[0];
      res.json({
        fileIdentifier: "domboshava-ward4-homestead-register",
        language: "eng",
        characterSet: "utf8",
        hierarchyLevel: "dataset",
        contact: { organisationName: req.app.locals.config.contact, role: "pointOfContact" },
        dateStamp: new Date().toISOString().slice(0, 10),
        metadataStandardName: "ISO 19115 (elements, simplified)",
        referenceSystemInfo: [
          {
            role: "storage",
            code: "MSU-CLIS:990031",
            name: "Arc 1950 / Gauss Conformal, Lo 31 belt (west-positive Y, south-positive X)",
            proj4: crs.rows[0] ? crs.rows[0].proj4text : null,
            caution: "The +towgs84 parameters are the regional Arc 1950 teaching set. They are not adequate for cadastral work; officially adopted parameters must be obtained and their source recorded here.",
          },
          { role: "output", code: "OGC:CRS84", name: "WGS 84 longitude/latitude (GeoJSON, RFC 7946)" },
        ],
        identificationInfo: {
          title: "Domboshava Ward 4 Homestead Register",
          abstract: "Homesteads in five villages of Domboshava Ward 4 (Gukwe, Murove, Chiroodza, Chirodzero, Maro), with customary allocations, council-recognised rights, restrictions and their documentary evidence, reconciled against the Goromonzi RDC levy register.",
          purpose: "Let Goromonzi Rural District Council see which homesteads hold a recognised allocation, which pay the development levy, and whether a homestead is already taken before it is allocated again.",
          status: "onGoing",
          keywords: ["land administration", "LADM", "customary tenure", "communal land", "Domboshava", "Goromonzi", "Zimbabwe"],
          extent: { bbox: ext[0] || null, crs: "OGC:CRS84" },
        },
        resourceConstraints: {
          useLimitation: "Boundaries are indicative (handheld GNSS, imagery tracing or sketch) and carry no legal weight. This is not a title register; communal land is not registrable title.",
          accessConstraints: "Public: homestead status, right types, dates and the number of holders. Restricted to authenticated council clerks: names and shares of holders, levy payers. Personal data is processed under the Cyber and Data Protection Act [Chapter 12:07].",
        },
        dataQualityInfo: {
          lineage: "SYNTHETIC DEMONSTRATION DATA generated by db/03_seed.sql (setseed 0.4242). Village names are real; positions, shapes, people and accounts are invented. Real data replaces this only under the proposal's data protection plan.",
          measures: {
            homesteads: m.homesteads,
            invalidGeometries: m.invalid,
            homesteadsOverlappingANeighbour: m.overlapping,
            homesteadsWithNoRight: m.no_right,
            disputedHomesteads: m.disputed,
            levyAccounts: m.levy,
            levyAccountsMatched: m.levy_matched,
            levyMatchRate: m.levy ? Number((m.levy_matched / m.levy).toFixed(3)) : null,
          },
          lastChange: m.last_change,
        },
        distributionInfo: { onlineResource: `${baseUrl(req)}/`, protocol: "OGC API - Features (core, GeoJSON)" },
      });
    } catch (e) { next(e); }
  });

  // ---- Health: "what happens if the database is down?" ------------------
  r.get("/health", async (_req, res) => {
    try {
      await publicPool.query("SELECT 1");
      res.json({ status: "ok", database: "reachable" });
    } catch {
      res.status(503).json({ status: "degraded", database: "unreachable" });
    }
  });

  return r;
}

function iso(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  // pg returns DATE as a JS Date at local midnight; format without shifting
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Full rights history for a clerk, with holders and evidence.
async function clerkRights(apiPool, upi) {
  const { rows } = await apiPool.query(`
    SELECT r.rrr_id, r.rrr_kind, r.rrr_type, t.label, t.recognised, r.recognised_by,
           r.start_date, r.end_date, r.note,
           coalesce((SELECT jsonb_agg(jsonb_build_object(
                       'partyCode', pa.party_code, 'name', pa.full_name, 'sex', pa.sex,
                       'role', pr.role, 'share', pr.share_num || '/' || pr.share_den)
                       ORDER BY pr.role, pa.full_name)
                       FROM lis.party_rrr pr JOIN lis.party pa USING (party_id)
                      WHERE pr.rrr_id = r.rrr_id), '[]'::jsonb) AS parties,
           coalesce((SELECT jsonb_agg(jsonb_build_object(
                       'type', d.doc_type, 'reference', d.reference, 'issuedOn', d.issued_on)
                       ORDER BY d.issued_on NULLS LAST)
                       FROM lis.rrr_source rs JOIN lis.source_document d USING (doc_id)
                      WHERE rs.rrr_id = r.rrr_id), '[]'::jsonb) AS evidence
      FROM lis.rrr r
      JOIN lis.parcel p       ON p.parcel_id = r.parcel_id
      JOIN lis_ref.rrr_type t ON t.code = r.rrr_type
     WHERE p.upi = $1
     ORDER BY (r.end_date IS NULL) DESC, r.rrr_kind, r.start_date DESC`, [upi]);
  return rows.map((x) => ({
    id: x.rrr_id, kind: x.rrr_kind, type: x.rrr_type, label: x.label, lawfulBasis: x.recognised,
    recognisedBy: x.recognised_by, startDate: iso(x.start_date), endDate: iso(x.end_date),
    current: x.end_date === null, note: x.note,
    partyCount: x.parties.length, parties: x.parties, evidence: x.evidence,
  }));
}

module.exports = { publicRoutes, STATUS_TEXT, iso };
