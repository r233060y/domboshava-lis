-- =====================================================================
-- Domboshava Ward 4 Homestead Register — 04_queries.sql
-- The questions GRDC actually asks, in SQL. Run section by section and
-- compare with the expected results noted (synthetic seed, setseed 0.4242).
-- =====================================================================

-- §1 Axis convention (Manual §4.4.2). Domboshava is east of 31°E, so Y
--    (west-positive) is negative; X (south-positive) is about 1 947 500 m.
SELECT ST_AsText(ST_Transform(ST_SetSRID(ST_MakePoint(31.15, -17.61), 4326), 990031));
-- expected: POINT(-15923.83 1947523.58)

-- §2 Status of every homestead: the council's decision variable.
SELECT status, count(*) AS homesteads
  FROM lis.parcel_status GROUP BY status ORDER BY homesteads DESC;

-- §3 How much of Ward 4 rests on a lawful, council-recognised basis?
SELECT t.label, t.recognised, r.recognised_by, count(*) AS current_rights
  FROM lis.rrr r JOIN lis_ref.rrr_type t ON t.code = r.rrr_type
 WHERE r.rrr_kind = 'RIGHT' AND r.end_date IS NULL
 GROUP BY 1, 2, 3 ORDER BY current_rights DESC;
-- Nothing here is registrable title (registrable = false for every
-- type): ask what a bank would lend against.

-- §4 Overlapping homesteads (expected: 2 pairs, Murove 6/7 and Maro 2/3)
SELECT a.upi, b.upi, round(ST_Area(ST_Intersection(a.geom, b.geom))::numeric, 1) AS overlap_m2
  FROM lis.parcel a JOIN lis.parcel b
    ON a.parcel_id < b.parcel_id AND ST_Overlaps(a.geom, b.geom);

-- §5 Double allocations: more than one current right on a homestead
SELECT p.upi, count(*) AS current_rights,
       string_agg(r.rrr_type || ' (' || r.recognised_by || ')', '; ') AS claims
  FROM lis.rrr r JOIN lis.parcel p USING (parcel_id)
 WHERE r.rrr_kind = 'RIGHT' AND r.end_date IS NULL
 GROUP BY p.upi HAVING count(*) > 1;

-- §6 Joint holding: rights held in shares (section 80 of the Constitution)
SELECT p.upi, pa.party_code, pr.role, pr.share_num || '/' || pr.share_den AS share, pa.sex
  FROM lis.party_rrr pr
  JOIN lis.rrr r    USING (rrr_id)
  JOIN lis.parcel p USING (parcel_id)
  JOIN lis.party pa USING (party_id)
 WHERE pr.share_den > 1 AND r.end_date IS NULL
 ORDER BY p.upi, pr.role;

-- §7 Who holds current rights, by sex (aggregate only: proposal §4)
SELECT pa.sex, count(DISTINCT pa.party_id) AS holders
  FROM lis.party_rrr pr
  JOIN lis.rrr r    USING (rrr_id)
  JOIN lis.party pa USING (party_id)
 WHERE r.rrr_kind = 'RIGHT' AND r.end_date IS NULL
 GROUP BY pa.sex;

-- §8 Reconciliation: run the automatic levy match, then read the summary.
--    Set who is acting first, or the audit log records 'unknown'.
BEGIN;
SELECT set_config('lis.current_user', 'lab:your-name', true);
SELECT lis.reconcile_levy_exact() AS matched_now;
COMMIT;

SELECT * FROM lis.reconciliation_summary ORDER BY village;

-- §9 What the match could not do: references a clerk must match by hand
SELECT account_no, homestead_ref_raw, lis.normalise_homestead_ref(homestead_ref_raw) AS normalised
  FROM lis.levy_account WHERE parcel_id IS NULL ORDER BY account_no;

-- §10 Occupied homesteads that pay no levy: the revenue gap
SELECT p.upi, s.status
  FROM lis.parcel p JOIN lis.parcel_status s USING (parcel_id)
 WHERE s.status <> 'NO_RIGHT'
   AND NOT EXISTS (SELECT 1 FROM lis.levy_account l WHERE l.parcel_id = p.parcel_id)
 ORDER BY p.upi;

-- §11 Allocation-book entries that match no homestead (expected: 4)
SELECT reference, homestead_ref_raw
  FROM lis.source_document d
 WHERE doc_type = 'ALLOCATION_BOOK_ENTRY'
   AND NOT EXISTS (SELECT 1 FROM lis.rrr_source rs WHERE rs.doc_id = d.doc_id);

-- §12 Everything the validation view flags
SELECT * FROM lis.parcel_validation
 WHERE invalid_geometry OR overlaps_neighbour OR outside_village OR no_current_right
    OR competing_rights OR right_without_evidence OR right_without_holder
 ORDER BY upi;

-- §13 Nearest homesteads to a GNSS fix (the point arrives in WGS 84 and
--     is transformed INTO the local system: never the reverse, §4.4.4)
WITH here AS (
  SELECT ST_Transform(ST_SetSRID(ST_MakePoint(31.1585, -17.6045), 4326), 990031) AS pt
)
SELECT p.upi, round(ST_Distance(p.geom, h.pt)::numeric, 1) AS metres
  FROM lis.parcel p, here h
 WHERE ST_DWithin(p.geom, h.pt, 150)
 ORDER BY metres;

-- §14 Prove the spatial index is used (look for "parcel_geom_gix").
--     With 65 rows the planner may prefer a sequential scan; run
--     SET enable_seqscan = off; first to see the index plan.
EXPLAIN (ANALYZE, BUFFERS)
SELECT upi FROM lis.parcel
 WHERE geom && ST_Transform(ST_MakeEnvelope(31.155, -17.607, 31.162, -17.601, 4326), 990031);

-- §15 Least privilege: these must FAIL when run as lis_api
--   SET ROLE lis_api;
--   DELETE FROM lis.parcel WHERE upi = 'GRD-W4GUK-00001';   -- permission denied
--   UPDATE lis.audit_log SET changed_by = 'nobody';         -- permission denied
--   RESET ROLE;

-- §16 The audit trail for one homestead
SELECT changed_at, changed_by, table_name, action, changed_cols
  FROM lis.audit_log
 WHERE record_pk = (SELECT parcel_id::text FROM lis.parcel WHERE upi = 'GRD-W4MUR-00006')
 ORDER BY changed_at;
