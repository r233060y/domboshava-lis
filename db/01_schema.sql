-- =====================================================================
-- Domboshava Ward 4 Homestead Register — 01_schema.sql
-- HSVG437 Cadastres and LIS capstone
--
-- Run as the database owner (e.g. postgres) inside the target database,
-- either way:
--   pgAdmin: Query Tool on the database, open this file, press F5
--   psql:    psql -v ON_ERROR_STOP=1 -d domboshava_lis -f db/01_schema.sql
-- The whole file is one transaction: if anything fails, nothing is kept,
-- so it is safe to fix the problem and run it again.
--
-- Design rule (Manual §4.1): if a rule matters, it is enforced HERE,
-- not in the application.
-- =====================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------
-- 1. Coordinate reference system: Arc 1950 Gauss Conformal, Lo 31 belt
--    Domboshava lies just east of 31°E, so Y (west-positive) is small
--    and NEGATIVE (about -15 900 m); X (south-positive) is ~1 947 500 m.
--    WARNING (Manual §4.4.2): +towgs84 below is the regional teaching
--    set. It is NOT adequate for cadastral work; obtain the officially
--    adopted parameters and record their source in /api/metadata.
-- ---------------------------------------------------------------------
INSERT INTO spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text)
VALUES (990031, 'MSU-CLIS', 990031, '',
        '+proj=tmerc +lat_0=0 +lon_0=31 +k=1 +x_0=0 +y_0=0 +axis=wsu '
        '+ellps=clrk80 +towgs84=-143,-90,-294 +units=m +no_defs')
ON CONFLICT (srid) DO NOTHING;

CREATE SCHEMA IF NOT EXISTS lis_ref;   -- lookups (domains)
CREATE SCHEMA IF NOT EXISTS lis;       -- the register

-- ---------------------------------------------------------------------
-- 2. Lookups. Domains are where data quality is won or lost (§4.2):
--    every coded value is a foreign key, never free text.
-- ---------------------------------------------------------------------
CREATE TABLE lis_ref.party_type (
    code   text PRIMARY KEY,
    label  text NOT NULL
);

-- LA_RRRType. One table for rights, restrictions and responsibilities;
-- the (code, rrr_kind) pair is referenced as a composite key so a right
-- type can never be recorded as a restriction by mistake.
CREATE TABLE lis_ref.rrr_type (
    code         text PRIMARY KEY,
    rrr_kind     text NOT NULL CHECK (rrr_kind IN ('RIGHT','RESTRICTION','RESPONSIBILITY')),
    label        text NOT NULL,
    recognised   boolean NOT NULL,   -- lawful basis of occupation under the Communal Land Act?
    registrable  boolean NOT NULL,   -- can it be registered at the Deeds Registry? (communal land: no)
    UNIQUE (code, rrr_kind)
);

CREATE TABLE lis_ref.doc_type (
    code   text PRIMARY KEY,
    label  text NOT NULL
);

CREATE TABLE lis_ref.boundary_quality (
    code   text PRIMARY KEY,
    label  text NOT NULL,
    legal  boolean NOT NULL DEFAULT false   -- none of these is a legal boundary
);

-- ---------------------------------------------------------------------
-- 3. Administrative/spatial grouping: villages (LA_SpatialUnitGroup)
-- ---------------------------------------------------------------------
CREATE TABLE lis.village (
    village_id     smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code           char(3) NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{3}$'),
    name           text    NOT NULL UNIQUE,
    ward           smallint NOT NULL DEFAULT 4 CHECK (ward BETWEEN 1 AND 40),
    head_party_id  uuid,   -- FK added after lis.party exists
    geom           geometry(MultiPolygon, 990031) NOT NULL
                   CHECK (ST_IsValid(geom)),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 4. LA_SpatialUnit: homesteads
-- ---------------------------------------------------------------------
CREATE TABLE lis.parcel (
    parcel_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    upi               text NOT NULL UNIQUE
                      -- module-wide format (§4.5.1) ...
                      CHECK (upi ~ '^[A-Z]{3}-[A-Z0-9]{2,6}-[0-9]{5}$')
                      -- ... and this project's scheme: GRD-W4<village>-<nnnnn>
                      CHECK (upi ~ '^GRD-W[0-9]{1,2}[A-Z]{3}-[0-9]{5}$'),
    village_id        smallint NOT NULL REFERENCES lis.village,
    homestead_no      integer  NOT NULL CHECK (homestead_no BETWEEN 1 AND 99999),
    land_use          text NOT NULL DEFAULT 'RESIDENTIAL'
                      CHECK (land_use IN ('RESIDENTIAL','AGRICULTURE','MIXED')),
    boundary_quality  text NOT NULL REFERENCES lis_ref.boundary_quality,
    source_agency     text NOT NULL
                      CHECK (source_agency IN ('GROUP_FIELDWORK','GRDC','VILLAGE_HEAD','OSM')),
    reconciled        boolean NOT NULL DEFAULT false,
    geom              geometry(Polygon, 990031) NOT NULL
                      CHECK (ST_IsValid(geom))
                      CHECK (ST_SRID(geom) = 990031),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (village_id, homestead_no)          -- no duplicate homestead numbers
);
CREATE INDEX parcel_geom_gix ON lis.parcel USING GIST (geom);

-- The UPI is composed by the database from the village code and the
-- homestead number, so no application can invent a non-conforming one,
-- and it can never be changed afterwards (the surrogate key is stable,
-- the meaningful key is protected).
CREATE FUNCTION lis.parcel_upi_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_code char(3); v_ward smallint;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT code, ward INTO v_code, v_ward FROM lis.village WHERE village_id = NEW.village_id;
        IF v_code IS NULL THEN
            RAISE EXCEPTION 'Village % does not exist', NEW.village_id;
        END IF;
        NEW.upi := format('GRD-W%s%s-%s', v_ward, v_code, lpad(NEW.homestead_no::text, 5, '0'));
    ELSE
        IF NEW.upi IS DISTINCT FROM OLD.upi
           OR NEW.parcel_id IS DISTINCT FROM OLD.parcel_id
           OR NEW.village_id IS DISTINCT FROM OLD.village_id
           OR NEW.homestead_no IS DISTINCT FROM OLD.homestead_no THEN
            RAISE EXCEPTION 'A homestead''s identifier (UPI %) cannot be changed', OLD.upi;
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER parcel_upi_guard
    BEFORE INSERT OR UPDATE ON lis.parcel
    FOR EACH ROW EXECUTE FUNCTION lis.parcel_upi_guard();

-- ---------------------------------------------------------------------
-- 5. LA_Party. full_name and sex are RESTRICTED personal columns: they
--    never appear in any public view. No national ID numbers are stored
--    (proposal §4, minimisation); each party gets a local party_code.
-- ---------------------------------------------------------------------
CREATE SEQUENCE lis.party_code_seq START 1;

CREATE TABLE lis.party (
    party_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    party_code  text NOT NULL UNIQUE
                DEFAULT 'P-' || lpad(nextval('lis.party_code_seq')::text, 5, '0')
                CHECK (party_code ~ '^P-[0-9]{5}$'),
    party_type  text NOT NULL REFERENCES lis_ref.party_type,
    full_name   text NOT NULL CHECK (length(btrim(full_name)) >= 2),   -- RESTRICTED
    sex         char(1) CHECK (sex IN ('F','M')),                        -- RESTRICTED
    village_id  smallint REFERENCES lis.village,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (party_type <> 'PERSON' OR sex IS NOT NULL)
);

ALTER TABLE lis.village
    ADD CONSTRAINT village_head_fk FOREIGN KEY (head_party_id) REFERENCES lis.party;

-- ---------------------------------------------------------------------
-- 6. LA_RRR. History is kept, never overwritten (§4.3a): a transfer
--    closes one right (end_date) and opens another.
-- ---------------------------------------------------------------------
CREATE TABLE lis.rrr (
    rrr_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parcel_id      uuid NOT NULL REFERENCES lis.parcel,
    rrr_kind       text NOT NULL,
    rrr_type       text NOT NULL,
    recognised_by  text NOT NULL DEFAULT 'NONE'
                   CHECK (recognised_by IN ('GRDC','VILLAGE_HEAD','NONE')),
    start_date     date NOT NULL,
    end_date       date,
    note           text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (rrr_type, rrr_kind) REFERENCES lis_ref.rrr_type (code, rrr_kind),
    CHECK (end_date IS NULL OR end_date >= start_date),   -- no right ends before it begins
    CHECK (start_date >= DATE '1900-01-01')
);
CREATE INDEX rrr_parcel_idx ON lis.rrr (parcel_id) WHERE end_date IS NULL;

-- The council cannot consent twice to the same homestead. Unrecognised
-- claims MAY coexist (they are recorded as found, and flagged as a
-- dispute), but a second current GRDC-recognised right is refused here,
-- whatever application or import script tries it.
CREATE UNIQUE INDEX rrr_one_grdc_right_per_parcel
    ON lis.rrr (parcel_id)
    WHERE rrr_kind = 'RIGHT' AND recognised_by = 'GRDC' AND end_date IS NULL;

-- ---------------------------------------------------------------------
-- 7. Junction: who holds which right, in what share (§4.2: a single
--    owner_name column would make a wife's half share unrecordable).
-- ---------------------------------------------------------------------
CREATE TABLE lis.party_rrr (
    rrr_id     uuid NOT NULL REFERENCES lis.rrr ON DELETE CASCADE,
    party_id   uuid NOT NULL REFERENCES lis.party,
    share_num  integer NOT NULL DEFAULT 1 CHECK (share_num > 0),
    share_den  integer NOT NULL DEFAULT 1 CHECK (share_den > 0),
    role       text NOT NULL DEFAULT 'HOLDER'
               CHECK (role IN ('HOLDER','SPOUSE','HEIR','CLAIMANT')),
    PRIMARY KEY (rrr_id, party_id),
    CHECK (share_num <= share_den)
);

-- Shares in a right must sum to one whole. A CHECK cannot see other
-- rows, so this is a DEFERRED constraint trigger (§4.5.2): during a
-- two-holder insert the sum is legitimately 1/2 mid-transaction.
CREATE FUNCTION lis.check_shares() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_rrr  uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.rrr_id ELSE NEW.rrr_id END;
    v_sum  numeric;
    v_n    integer;
BEGIN
    SELECT sum(share_num::numeric / share_den), count(*)
      INTO v_sum, v_n
      FROM lis.party_rrr WHERE rrr_id = v_rrr;
    IF v_n > 0 AND abs(v_sum - 1) > 0.000001 THEN
        RAISE EXCEPTION 'Shares for this right add up to % of the whole, not 1. Check each holder''s share.',
              round(v_sum, 4)
              USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER party_rrr_shares
    AFTER INSERT OR UPDATE OR DELETE ON lis.party_rrr
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION lis.check_shares();

-- ---------------------------------------------------------------------
-- 8. LA_Source. Allocation-book entries, council consents, receipts,
--    affidavits, consent forms. A book entry with no linked right is an
--    unmatched entry: a finding of the reconciliation, not an error.
-- ---------------------------------------------------------------------
CREATE TABLE lis.source_document (
    doc_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_type           text NOT NULL REFERENCES lis_ref.doc_type,
    reference          text NOT NULL CHECK (length(btrim(reference)) >= 3),
    issued_on          date,
    uri                text,
    village_id         smallint REFERENCES lis.village,
    homestead_ref_raw  text,      -- as written in the book or receipt
    holder_name_raw    text,      -- RESTRICTED: as written in the source
    captured_by        text NOT NULL,
    captured_at        timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lis.rrr_source (
    rrr_id  uuid NOT NULL REFERENCES lis.rrr ON DELETE CASCADE,
    doc_id  uuid NOT NULL REFERENCES lis.source_document,
    PRIMARY KEY (rrr_id, doc_id)
);

-- ---------------------------------------------------------------------
-- 9. The council's levy register, loaded as found and reconciled
--    against homesteads. parcel_id is NULL until matched.
-- ---------------------------------------------------------------------
CREATE TABLE lis.levy_account (
    account_no         text PRIMARY KEY CHECK (account_no ~ '^GRDC-L-[0-9]{5}$'),
    village_id         smallint REFERENCES lis.village,
    homestead_ref_raw  text NOT NULL,     -- as written in the council register
    payer_name_raw     text NOT NULL,     -- RESTRICTED
    payer_party_id     uuid REFERENCES lis.party,
    parcel_id          uuid REFERENCES lis.parcel,
    match_method       text CHECK (match_method IN ('EXACT_REF','MANUAL')),
    matched_on         date,
    matched_by         text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- a match is all-or-nothing: no half-recorded matches
    CHECK ((parcel_id IS NULL) = (match_method IS NULL)),
    CHECK ((parcel_id IS NULL) = (matched_on IS NULL))
);

-- ---------------------------------------------------------------------
-- 10. Application users (clerks and administrators). Passwords are
--     stored only as scrypt hashes produced by server/scripts/create-user.js.
-- ---------------------------------------------------------------------
CREATE TABLE lis.app_user (
    username       text PRIMARY KEY CHECK (username ~ '^[a-z][a-z0-9_.]{2,31}$'),
    display_name   text NOT NULL,
    role           text NOT NULL CHECK (role IN ('clerk','admin')),
    password_hash  text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
    active         boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 11. updated_at maintenance (a technical column: the audit trigger
--     ignores it when deciding whether anything changed, §4.5.3).
-- ---------------------------------------------------------------------
CREATE FUNCTION lis.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['village','parcel','party','rrr','source_document','levy_account']
    LOOP
        EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON lis.%I
                        FOR EACH ROW EXECUTE FUNCTION lis.touch_updated_at()', t, t);
    END LOOP;
END $$;

-- =====================================================================
-- 12. VIEWS
-- =====================================================================

-- Current status of every homestead: the council's decision variable.
--   RECOGNISED          one current right with GRDC consent on record
--   CUSTOMARY_ONLY      allocated by a village head, no GRDC consent yet
--   UNRECOGNISED_CLAIM  a claim with no lawful basis (informal purchase,
--                       undocumented occupation)
--   DISPUTED            more than one current right: a double allocation
--   NO_RIGHT            occupied or mapped, but no right recorded at all
CREATE VIEW lis.parcel_status AS
WITH cur AS (
    SELECT r.parcel_id,
           count(*)                                              AS n_rights,
           bool_or(r.recognised_by = 'GRDC')                     AS any_grdc,
           bool_or(t.recognised AND r.recognised_by = 'VILLAGE_HEAD') AS any_customary,
           max(r.start_date)                                     AS latest_start
      FROM lis.rrr r
      JOIN lis_ref.rrr_type t ON t.code = r.rrr_type
     WHERE r.rrr_kind = 'RIGHT' AND r.end_date IS NULL
     GROUP BY r.parcel_id
)
SELECT p.parcel_id,
       CASE
         WHEN cur.n_rights IS NULL THEN 'NO_RIGHT'
         WHEN cur.n_rights > 1     THEN 'DISPUTED'
         WHEN cur.any_grdc         THEN 'RECOGNISED'
         WHEN cur.any_customary    THEN 'CUSTOMARY_ONLY'
         ELSE 'UNRECOGNISED_CLAIM'
       END AS status,
       coalesce(cur.n_rights, 0) AS current_rights,
       cur.latest_start
  FROM lis.parcel p
  LEFT JOIN cur ON cur.parcel_id = p.parcel_id;

-- The publishable subset (§4.3c): NO personal columns exist here, so
-- the public API cannot leak a name even through a coding slip.
CREATE VIEW lis.parcel_public AS
SELECT p.upi,
       v.code                              AS village_code,
       v.name                              AS village,
       v.ward,
       p.homestead_no,
       p.land_use,
       p.boundary_quality,
       round(ST_Area(p.geom)::numeric, 0)  AS area_m2,   -- measured in the local metric CRS
       s.status,
       s.current_rights,
       (SELECT count(*) FROM lis.rrr r
         WHERE r.parcel_id = p.parcel_id AND r.rrr_kind = 'RESTRICTION'
           AND r.end_date IS NULL)         AS current_restrictions,
       p.updated_at,
       p.geom
  FROM lis.parcel p
  JOIN lis.village v       ON v.village_id = p.village_id
  JOIN lis.parcel_status s ON s.parcel_id = p.parcel_id;

-- Rights as the public may see them: existence, kind, type, dates and the
-- NUMBER of parties — never who they are (Manual §5.4).
CREATE VIEW lis.rrr_public AS
SELECT p.upi,
       r.rrr_kind,
       r.rrr_type,
       t.label                      AS rrr_label,
       t.recognised,
       r.recognised_by,
       r.start_date,
       r.end_date,
       (SELECT count(*) FROM lis.party_rrr pr WHERE pr.rrr_id = r.rrr_id) AS party_count,
       (SELECT count(*) FROM lis.rrr_source rs WHERE rs.rrr_id = r.rrr_id) AS evidence_count
  FROM lis.rrr r
  JOIN lis.parcel p       ON p.parcel_id = r.parcel_id
  JOIN lis_ref.rrr_type t ON t.code = r.rrr_type
 WHERE r.end_date IS NULL;

CREATE VIEW lis.village_public AS
SELECT v.code, v.name, v.ward, v.geom,
       (SELECT count(*) FROM lis.parcel p WHERE p.village_id = v.village_id) AS homesteads
  FROM lis.village v;

-- Pre-submission validation (§7.3): what a clerk should see before
-- accepting an edit, and what the progress check-in should be able to
-- show is being measured rather than described.
CREATE VIEW lis.parcel_validation AS
SELECT p.upi,
       v.name AS village,
       NOT ST_IsValid(p.geom) AS invalid_geometry,
       EXISTS (SELECT 1 FROM lis.parcel o
                WHERE o.parcel_id <> p.parcel_id
                  AND ST_Overlaps(o.geom, p.geom))         AS overlaps_neighbour,
       (SELECT string_agg(o.upi, ', ' ORDER BY o.upi) FROM lis.parcel o
         WHERE o.parcel_id <> p.parcel_id
           AND ST_Overlaps(o.geom, p.geom))                AS overlapping_upis,
       NOT ST_Within(p.geom, v.geom)                       AS outside_village,
       s.status = 'NO_RIGHT'                               AS no_current_right,
       s.status = 'DISPUTED'                               AS competing_rights,
       EXISTS (SELECT 1 FROM lis.rrr r
                WHERE r.parcel_id = p.parcel_id AND r.end_date IS NULL
                  AND r.rrr_kind = 'RIGHT'
                  AND NOT EXISTS (SELECT 1 FROM lis.rrr_source rs WHERE rs.rrr_id = r.rrr_id)
              )                                            AS right_without_evidence,
       EXISTS (SELECT 1 FROM lis.rrr r
                WHERE r.parcel_id = p.parcel_id AND r.end_date IS NULL
                  AND r.rrr_kind = 'RIGHT'
                  AND NOT EXISTS (SELECT 1 FROM lis.party_rrr pr WHERE pr.rrr_id = r.rrr_id)
              )                                            AS right_without_holder
  FROM lis.parcel p
  JOIN lis.village v       ON v.village_id = p.village_id
  JOIN lis.parcel_status s ON s.parcel_id = p.parcel_id;

-- Reconciliation, by village: the proposal's central finding.
CREATE VIEW lis.reconciliation_summary AS
SELECT v.code AS village_code,
       v.name AS village,
       (SELECT count(*) FROM lis.parcel p WHERE p.village_id = v.village_id)                         AS homesteads,
       (SELECT count(*) FROM lis.parcel p JOIN lis.parcel_status s USING (parcel_id)
         WHERE p.village_id = v.village_id AND s.status = 'RECOGNISED')                               AS recognised,
       (SELECT count(*) FROM lis.parcel p JOIN lis.parcel_status s USING (parcel_id)
         WHERE p.village_id = v.village_id AND s.status = 'CUSTOMARY_ONLY')                           AS customary_only,
       (SELECT count(*) FROM lis.parcel p JOIN lis.parcel_status s USING (parcel_id)
         WHERE p.village_id = v.village_id AND s.status = 'UNRECOGNISED_CLAIM')                       AS unrecognised_claim,
       (SELECT count(*) FROM lis.parcel p JOIN lis.parcel_status s USING (parcel_id)
         WHERE p.village_id = v.village_id AND s.status = 'DISPUTED')                                 AS disputed,
       (SELECT count(*) FROM lis.parcel p JOIN lis.parcel_status s USING (parcel_id)
         WHERE p.village_id = v.village_id AND s.status = 'NO_RIGHT')                                 AS no_right,
       (SELECT count(*) FROM lis.levy_account l WHERE l.village_id = v.village_id)                   AS levy_accounts,
       (SELECT count(*) FROM lis.levy_account l WHERE l.village_id = v.village_id
                                                  AND l.parcel_id IS NOT NULL)                       AS levy_matched,
       (SELECT count(*) FROM lis.levy_account l WHERE l.village_id = v.village_id
                                                  AND l.parcel_id IS NULL)                           AS levy_unmatched,
       (SELECT count(*) FROM lis.parcel p JOIN lis.parcel_status s USING (parcel_id)
         WHERE p.village_id = v.village_id AND s.status <> 'NO_RIGHT'
           AND NOT EXISTS (SELECT 1 FROM lis.levy_account l WHERE l.parcel_id = p.parcel_id))         AS occupied_unlevied,
       (SELECT count(*) FROM lis.source_document d
         WHERE d.village_id = v.village_id AND d.doc_type = 'ALLOCATION_BOOK_ENTRY')                  AS book_entries,
       (SELECT count(*) FROM lis.source_document d
         WHERE d.village_id = v.village_id AND d.doc_type = 'ALLOCATION_BOOK_ENTRY'
           AND NOT EXISTS (SELECT 1 FROM lis.rrr_source rs WHERE rs.doc_id = d.doc_id))               AS book_unmatched
  FROM lis.village v;

-- ---------------------------------------------------------------------
-- 13. Automatic levy matching: normalise the homestead reference as
--     written ("12", "Hse 12", "No. 012", "House 12") and match it to a
--     homestead in the same village. Anything messier ("12A", "12 (old)")
--     is left for a clerk to match by hand: the unmatched rows are the
--     finding, not the failure (§4.7).
-- ---------------------------------------------------------------------
CREATE FUNCTION lis.normalise_homestead_ref(p_raw text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
    SELECT (regexp_match(lower(btrim(p_raw)),
                         '^(?:hse|house|no\.?|plot|stand)?\s*0*([0-9]{1,5})$'))[1]::integer
$$;

CREATE FUNCTION lis.reconcile_levy_exact() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    v_n integer;
    v_who text := coalesce(nullif(current_setting('lis.current_user', true), ''), 'unknown');
BEGIN
    UPDATE lis.levy_account l
       SET parcel_id    = p.parcel_id,
           match_method = 'EXACT_REF',
           matched_on   = current_date,
           matched_by   = v_who
      FROM lis.parcel p
     WHERE l.parcel_id IS NULL
       AND p.village_id = l.village_id
       AND p.homestead_no = lis.normalise_homestead_ref(l.homestead_ref_raw);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END $$;

COMMIT;
