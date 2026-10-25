-- =====================================================================
-- Domboshava Ward 4 Homestead Register — 02_audit_and_security.sql
-- Append-only audit log with per-user attribution, and least-privilege
-- database roles. Run as the database owner after 01_schema.sql
-- (pgAdmin: Query Tool, open, F5; psql: add -v ON_ERROR_STOP=1).
--
-- AFTER RUNNING, set passwords (there are deliberately no defaults):
--   ALTER ROLE lis_api    PASSWORD '...';
--   ALTER ROLE lis_public PASSWORD '...';
-- Roles belong to the whole PostgreSQL server, not one database. If
-- lis_api already exists from the Gweru reference lab, it is reused:
-- keep its existing password, or both projects' .env files must change.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1. Audit log (Manual §4.5.3)
-- ---------------------------------------------------------------------
CREATE TABLE lis.audit_log (
    audit_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name    text        NOT NULL,
    record_pk     text        NOT NULL,
    action        char(1)     NOT NULL CHECK (action IN ('I','U','D')),
    changed_at    timestamptz NOT NULL DEFAULT now(),
    changed_by    text        NOT NULL,     -- the APPLICATION user, not the DB role
    db_role       text        NOT NULL DEFAULT current_user,
    old_values    jsonb,
    new_values    jsonb,
    changed_cols  text[]
);
CREATE INDEX audit_log_record_idx ON lis.audit_log (table_name, record_pk);
CREATE INDEX audit_log_time_idx   ON lis.audit_log (changed_at DESC);

-- Generic trigger. TG_ARGV holds the primary-key column name(s).
-- SECURITY DEFINER so it can write the log even though lis_api cannot.
CREATE FUNCTION lis.audit_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, lis AS $$
DECLARE
    v_old    jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
    v_new    jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
    v_row    jsonb := coalesce(v_new, v_old);
    v_pk     text;
    v_cols   text[];
    -- technical columns: never count as a change (otherwise every no-op
    -- write logs a change because updated_at moved)
    v_ignore text[] := ARRAY['updated_at','created_at','captured_at'];
    v_who    text := coalesce(nullif(current_setting('lis.current_user', true), ''), 'unknown');
    i        int;
BEGIN
    SELECT string_agg(v_row ->> TG_ARGV[k], '|' ORDER BY k)
      INTO v_pk
      FROM generate_subscripts(TG_ARGV, 1) AS k;

    IF TG_OP = 'UPDATE' THEN
        SELECT array_agg(key ORDER BY key) INTO v_cols
          FROM jsonb_each(v_new) n
         WHERE NOT (key = ANY (v_ignore))
           AND (v_old -> key) IS DISTINCT FROM n.value;
        IF v_cols IS NULL THEN
            RETURN NULL;              -- nothing real changed: log nothing
        END IF;
        -- store only what changed, keeping the log readable
        v_old := (SELECT jsonb_object_agg(k, v_old -> k) FROM unnest(v_cols) k);
        v_new := (SELECT jsonb_object_agg(k, v_new -> k) FROM unnest(v_cols) k);
    END IF;

    -- never copy geometry blobs into the log; record that it changed
    IF v_old ? 'geom' THEN v_old := jsonb_set(v_old, '{geom}', '"<geometry>"'); END IF;
    IF v_new ? 'geom' THEN v_new := jsonb_set(v_new, '{geom}', '"<geometry>"'); END IF;

    INSERT INTO lis.audit_log (table_name, record_pk, action, changed_by,
                               old_values, new_values, changed_cols)
    VALUES (TG_TABLE_NAME, v_pk, left(TG_OP, 1), v_who, v_old, v_new, v_cols);
    RETURN NULL;
END $$;

CREATE TRIGGER village_audit         AFTER INSERT OR UPDATE OR DELETE ON lis.village
    FOR EACH ROW EXECUTE FUNCTION lis.audit_trigger('village_id');
CREATE TRIGGER parcel_audit          AFTER INSERT OR UPDATE OR DELETE ON lis.parcel
    FOR EACH ROW EXECUTE FUNCTION lis.audit_trigger('parcel_id');
CREATE TRIGGER party_audit           AFTER INSERT OR UPDATE OR DELETE ON lis.party
    FOR EACH ROW EXECUTE FUNCTION lis.audit_trigger('party_id');
CREATE TRIGGER rrr_audit             AFTER INSERT OR UPDATE OR DELETE ON lis.rrr
    FOR EACH ROW EXECUTE FUNCTION lis.audit_trigger('rrr_id');
CREATE TRIGGER party_rrr_audit       AFTER INSERT OR UPDATE OR DELETE ON lis.party_rrr
    FOR EACH ROW EXECUTE FUNCTION lis.audit_trigger('rrr_id', 'party_id');
CREATE TRIGGER source_document_audit AFTER INSERT OR UPDATE OR DELETE ON lis.source_document
    FOR EACH ROW EXECUTE FUNCTION lis.audit_trigger('doc_id');
CREATE TRIGGER rrr_source_audit      AFTER INSERT OR UPDATE OR DELETE ON lis.rrr_source
    FOR EACH ROW EXECUTE FUNCTION lis.audit_trigger('rrr_id', 'doc_id');
CREATE TRIGGER levy_account_audit    AFTER INSERT OR UPDATE OR DELETE ON lis.levy_account
    FOR EACH ROW EXECUTE FUNCTION lis.audit_trigger('account_no');
CREATE TRIGGER app_user_audit        AFTER INSERT OR UPDATE OR DELETE ON lis.app_user
    FOR EACH ROW EXECUTE FUNCTION lis.audit_trigger('username');

-- The app_user audit must never store password hashes.
CREATE FUNCTION lis.audit_strip_secrets() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.table_name = 'app_user' THEN
        IF NEW.old_values ? 'password_hash' THEN
            NEW.old_values := jsonb_set(NEW.old_values, '{password_hash}', '"<redacted>"');
        END IF;
        IF NEW.new_values ? 'password_hash' THEN
            NEW.new_values := jsonb_set(NEW.new_values, '{password_hash}', '"<redacted>"');
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER audit_strip_secrets BEFORE INSERT ON lis.audit_log
    FOR EACH ROW EXECUTE FUNCTION lis.audit_strip_secrets();

-- ---------------------------------------------------------------------
-- 2. Roles (Manual §4.6). Created NOLOGIN-safe: they can log in, but
--    there is no password until you set one, so no default exists.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lis_api') THEN
        CREATE ROLE lis_api LOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lis_public') THEN
        CREATE ROLE lis_public LOGIN;
    END IF;
END $$;

REVOKE ALL ON SCHEMA lis, lis_ref FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA lis, lis_ref FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lis FROM PUBLIC;

-- lis_public: what an anonymous web request may touch. Views only.
-- The views run with their owner's rights, so lis_public needs no
-- access to the tables beneath them — and has none.
GRANT USAGE  ON SCHEMA lis, lis_ref TO lis_public;
GRANT SELECT ON lis.parcel_public, lis.rrr_public, lis.village_public TO lis_public;
GRANT SELECT ON ALL TABLES IN SCHEMA lis_ref TO lis_public;

-- lis_api: what an authenticated clerk's request may do.
GRANT USAGE  ON SCHEMA lis, lis_ref TO lis_api;
GRANT SELECT ON ALL TABLES IN SCHEMA lis, lis_ref TO lis_api;
GRANT INSERT, UPDATE ON lis.parcel, lis.party, lis.rrr, lis.party_rrr,
                        lis.source_document, lis.rrr_source, lis.levy_account
                     TO lis_api;
-- Correcting a holder list or an evidence link is allowed (and audited).
GRANT DELETE ON lis.party_rrr, lis.rrr_source TO lis_api;
-- NOT granted: DELETE on parcel, rrr, party, village, levy_account;
-- any write to audit_log or app_user; any write to lookups.
-- Deleting a homestead is an administrative act by a named person
-- with a reason, not something a web request can do.
GRANT USAGE ON SEQUENCE lis.party_code_seq TO lis_api;
GRANT EXECUTE ON FUNCTION lis.reconcile_levy_exact(),
                          lis.normalise_homestead_ref(text) TO lis_api;
-- app_user: lis_api may read it to check a login, and nothing else.
REVOKE INSERT, UPDATE, DELETE ON lis.app_user FROM lis_api;

COMMIT;
