-- =====================================================================
-- Domboshava Ward 4 Homestead Register — 03_seed.sql
--
-- SYNTHETIC DEMONSTRATION DATA. Every person, homestead, boundary,
-- levy account and book entry below is generated. Village names are
-- the five sampled villages; their positions and shapes are
-- illustrative only. Replace with real data only under the data
-- protection plan in the proposal (consent, pseudonymisation, no Git).
--
-- The data carries DELIBERATE defects. Do not "fix" them: they are
-- what the reconciliation and validation views exist to find.
--   * 2 overlapping homestead pairs           (Murove 6/7, Maro 2/3)
--   * 2 disputed homesteads (double allocation)
--   * homesteads with no right, customary-only and unrecognised claims
--   * levy references written inconsistently, 4 accounts for
--     homesteads that do not exist, and occupied homesteads with no
--     account at all
--   * 4 allocation-book entries that match no homestead
--   * informal purchases with no evidence on file
-- Deterministic: setseed() makes every run produce the same data.
--
-- Run ONCE, after 01 and 02, on an empty register (pgAdmin: Query Tool,
-- open, F5; psql: add -v ON_ERROR_STOP=1). A second run fails on the
-- lookups already present and changes nothing.
-- =====================================================================
BEGIN;
SELECT set_config('lis.current_user', 'seed:synthetic-generator', true);

-- ---------------------------------------------------------------------
-- Lookups
-- ---------------------------------------------------------------------
INSERT INTO lis_ref.party_type (code, label) VALUES
  ('PERSON',      'Natural person'),
  ('FAMILY',      'Family or lineage group'),
  ('INSTITUTION', 'Institution');

INSERT INTO lis_ref.rrr_type (code, rrr_kind, label, recognised, registrable) VALUES
  ('CUSTOMARY_ALLOCATION',   'RIGHT', 'Customary allocation',            true,  false),
  ('RDC_PERMIT',             'RIGHT', 'Council permit',                  true,  false),
  ('OFFER_LETTER',           'RIGHT', 'Offer letter',                    true,  false),
  ('INHERITANCE',            'RIGHT', 'Inheritance in the lineage',      true,  false),
  ('INFORMAL_PURCHASE',      'RIGHT', 'Informal purchase',               false, false),
  ('UNDOCUMENTED_OCCUPATION','RIGHT', 'Undocumented occupation',         false, false),
  ('WETLAND',                'RESTRICTION', 'Wetland: no building',      true,  false),
  ('ROAD_RESERVE',           'RESTRICTION', 'Road reserve',              true,  false),
  ('POWERLINE_SERVITUDE',    'RESTRICTION', 'Power-line servitude',      true,  false),
  ('BUILDING_LINE',          'RESTRICTION', 'Council building line',     true,  false),
  ('TRANSFER_NEEDS_CONSENT', 'RESTRICTION', 'Transfer needs village-head and council consent', true, false),
  ('PAY_DEVELOPMENT_LEVY',   'RESPONSIBILITY', 'Pay the council development levy', true, false);

INSERT INTO lis_ref.doc_type (code, label) VALUES
  ('ALLOCATION_BOOK_ENTRY', 'Village allocation book entry'),
  ('RDC_CONSENT',           'Council consent to allocation'),
  ('RDC_PERMIT',            'Council permit'),
  ('OFFER_LETTER',          'Offer letter'),
  ('LEVY_RECEIPT',          'Levy receipt'),
  ('AFFIDAVIT',             'Sworn affidavit'),
  ('FIELD_SURVEY',          'Field survey record'),
  ('CONSENT_FORM',          'Data-subject consent form');

INSERT INTO lis_ref.boundary_quality (code, label) VALUES
  ('GNSS_HANDHELD',  'Handheld GNSS, about 3–5 m'),
  ('IMAGERY_TRACED', 'Traced from imagery, about 5–10 m'),
  ('SKETCH',         'Sketch map, indicative only'),
  ('UNKNOWN',        'Unknown');

-- ---------------------------------------------------------------------
-- Helper functions (session-only, dropped automatically)
-- ---------------------------------------------------------------------
CREATE FUNCTION pg_temp.pick(a text[]) RETURNS text
LANGUAGE sql VOLATILE AS $$ SELECT a[1 + floor(random() * array_length(a, 1))::int] $$;

CREATE FUNCTION pg_temp.person(p_sex char, p_village smallint) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  f text[] := ARRAY['Rutendo','Chipo','Ruvimbo','Tsitsi','Memory','Fadzai','Chiedza',
                    'Vimbai','Rumbidzai','Precious','Tarisai','Nyarai','Patience','Sekai'];
  m text[] := ARRAY['Tawanda','Munyaradzi','Simbarashe','Tapiwa','Takunda','Tonderai',
                    'Garikai','Tichaona','Admire','Givemore','Farai','Kudakwashe','Tendekai'];
  s text[] := ARRAY['Moyo','Gumbo','Marufu','Chikowore','Mushonga','Nyamande','Chigumba',
                    'Matongo','Mutandwa','Zhou','Shumba','Mazarura','Chidziva','Nhamo',
                    'Musariri','Kanengoni','Chakanyuka','Mugwagwa','Zinyama','Makuvaza'];
  v_id uuid;
BEGIN
  INSERT INTO lis.party (party_type, full_name, sex, village_id)
  VALUES ('PERSON',
          pg_temp.pick(CASE WHEN p_sex = 'F' THEN f ELSE m END) || ' ' || pg_temp.pick(s),
          p_sex, p_village)
  RETURNING party_id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION pg_temp.doc(p_type text, p_ref text, p_issued date, p_village smallint,
                            p_ref_raw text, p_name_raw text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO lis.source_document (doc_type, reference, issued_on, village_id,
                                   homestead_ref_raw, holder_name_raw, captured_by)
  VALUES (p_type, p_ref, p_issued, p_village, p_ref_raw, p_name_raw, 'seed:synthetic-generator')
  RETURNING doc_id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION pg_temp.right_(p_parcel uuid, p_type text, p_by text,
                               p_start date, p_end date) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO lis.rrr (parcel_id, rrr_kind, rrr_type, recognised_by, start_date, end_date)
  VALUES (p_parcel, 'RIGHT', p_type, p_by, p_start, p_end)
  RETURNING rrr_id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION pg_temp.hold(p_rrr uuid, p_party uuid, p_num int, p_den int, p_role text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO lis.party_rrr (rrr_id, party_id, share_num, share_den, role)
  VALUES (p_rrr, p_party, p_num, p_den, p_role)
$$;

CREATE FUNCTION pg_temp.cite(p_rrr uuid, p_doc uuid) RETURNS void
LANGUAGE sql AS $$ INSERT INTO lis.rrr_source (rrr_id, doc_id) VALUES (p_rrr, p_doc) $$;

CREATE FUNCTION pg_temp.name_of(p uuid) RETURNS text
LANGUAGE sql AS $$ SELECT full_name FROM lis.party WHERE party_id = p $$;

CREATE FUNCTION pg_temp.rdate(p_from date, p_to date) RETURNS date
LANGUAGE sql VOLATILE AS $$ SELECT p_from + floor(random() * (p_to - p_from))::int $$;

-- ---------------------------------------------------------------------
-- Villages, homesteads, rights, evidence
-- ---------------------------------------------------------------------
DO $$
DECLARE
  -- code, name, lon, lat (illustrative positions near Domboshava)
  villages text[][] := ARRAY[
    ['GUK','Gukwe',      '31.1400','-17.5980'],
    ['MUR','Murove',     '31.1580','-17.6040'],
    ['CRZ','Chiroodza',  '31.1420','-17.6140'],
    ['CRD','Chirodzero', '31.1610','-17.6200'],
    ['MAR','Maro',       '31.1490','-17.6300']];
  -- one scenario letter per homestead (13 per village):
  --   R recognised (GRDC consent)      J recognised, married couple 1/2 each
  --   C customary only (village head)  H inheritance after a closed right
  --   T regularised: customary right closed, council permit opened
  --   I informal purchase              U undocumented occupation
  --   D disputed: two current claims   N no right recorded
  plans text[] := ARRAY[
    'RRJCCIIUNDHRC',
    'RJCCRIUNCHRRC',
    'RRCIIIJCNUTCR',
    'JRCCRNCHRUCRI',
    'RCJRCINCRDCTR'];
  vi int; i int; v_id smallint; v_code text; v_name text;
  c geometry; x0 float8; y0 float8; cx float8; cy float8; w float8; d float8;
  g geometry; p_id uuid; sc char; r1 uuid; r2 uuid; a uuid; b uuid;
  s date; e date; page int := 1; consent_no int := 100;
  v_use text; v_bq text; u float8;
BEGIN
  PERFORM setseed(0.4242);

  FOR vi IN 1 .. array_length(villages, 1) LOOP
    v_code := villages[vi][1];
    v_name := villages[vi][2];
    c  := ST_Transform(ST_SetSRID(ST_MakePoint(villages[vi][3]::float8, villages[vi][4]::float8), 4326), 990031);
    x0 := ST_X(c); y0 := ST_Y(c);

    INSERT INTO lis.village (code, name, ward, geom)
    VALUES (v_code, v_name, 4,
            ST_Multi(ST_MakeEnvelope(x0 - 250, y0 - 250, x0 + 250, y0 + 250, 990031)))
    RETURNING village_id INTO v_id;

    UPDATE lis.village SET head_party_id = pg_temp.person('M', v_id) WHERE village_id = v_id;

    FOR i IN 1 .. 13 LOOP
      w  := 30 + random() * 20;
      d  := 35 + random() * 20;
      cx := x0 + (((i - 1) % 4) - 1.5) * 80 + (random() - 0.5) * 10;
      cy := y0 + (((i - 1) / 4) - 1.5) * 85 + (random() - 0.5) * 10;
      g  := ST_Rotate(ST_MakeEnvelope(cx - w/2, cy - d/2, cx + w/2, cy + d/2, 990031),
                      radians((random() - 0.5) * 12), cx, cy);
      -- deliberate boundary conflicts
      IF (v_code = 'MUR' AND i = 6) OR (v_code = 'MAR' AND i = 2) THEN
        g := ST_Translate(g, 55, 0);
      END IF;

      u := random();
      v_use := CASE WHEN u < 0.60 THEN 'RESIDENTIAL' WHEN u < 0.85 THEN 'MIXED' ELSE 'AGRICULTURE' END;
      u := random();
      v_bq  := CASE WHEN u < 0.30 THEN 'GNSS_HANDHELD' WHEN u < 0.90 THEN 'IMAGERY_TRACED' ELSE 'SKETCH' END;

      INSERT INTO lis.parcel (village_id, homestead_no, land_use, boundary_quality,
                              source_agency, geom)
      VALUES (v_id, i, v_use, v_bq, 'GROUP_FIELDWORK', g)
      RETURNING parcel_id INTO p_id;

      sc := substr(plans[vi], i, 1);
      s  := pg_temp.rdate('1986-01-01', '2022-12-31');

      IF sc IN ('R','J','C','D','H','T') THEN
        page := page + 1;
      END IF;

      IF sc = 'R' THEN
        a  := pg_temp.person(CASE WHEN random() < 0.3 THEN 'F' ELSE 'M' END, v_id);
        r1 := pg_temp.right_(p_id, CASE WHEN random() < 0.2 THEN 'RDC_PERMIT' ELSE 'CUSTOMARY_ALLOCATION' END,
                             'GRDC', s, NULL);
        PERFORM pg_temp.hold(r1, a, 1, 1, 'HOLDER');
        PERFORM pg_temp.cite(r1, pg_temp.doc('ALLOCATION_BOOK_ENTRY',
                format('%s allocation book p.%s entry %s', v_name, page, i), s, v_id, i::text, pg_temp.name_of(a)));
        consent_no := consent_no + 1;
        PERFORM pg_temp.cite(r1, pg_temp.doc('RDC_CONSENT',
                format('GRDC/W4/ALLOC/%s/%s', extract(year FROM s)::int, consent_no), s + 30, v_id, NULL, NULL));

      ELSIF sc = 'J' THEN
        a  := pg_temp.person('M', v_id);
        b  := pg_temp.person('F', v_id);
        r1 := pg_temp.right_(p_id, 'CUSTOMARY_ALLOCATION', 'GRDC', s, NULL);
        PERFORM pg_temp.hold(r1, a, 1, 2, 'HOLDER');
        PERFORM pg_temp.hold(r1, b, 1, 2, 'SPOUSE');
        PERFORM pg_temp.cite(r1, pg_temp.doc('ALLOCATION_BOOK_ENTRY',
                format('%s allocation book p.%s entry %s', v_name, page, i), s, v_id, i::text,
                pg_temp.name_of(a) || ' and ' || pg_temp.name_of(b)));
        consent_no := consent_no + 1;
        PERFORM pg_temp.cite(r1, pg_temp.doc('RDC_CONSENT',
                format('GRDC/W4/ALLOC/%s/%s', extract(year FROM s)::int, consent_no), s + 30, v_id, NULL, NULL));

      ELSIF sc = 'C' THEN
        a  := pg_temp.person(CASE WHEN random() < 0.35 THEN 'F' ELSE 'M' END, v_id);
        r1 := pg_temp.right_(p_id, 'CUSTOMARY_ALLOCATION', 'VILLAGE_HEAD', s, NULL);
        PERFORM pg_temp.hold(r1, a, 1, 1, 'HOLDER');
        PERFORM pg_temp.cite(r1, pg_temp.doc('ALLOCATION_BOOK_ENTRY',
                format('%s allocation book p.%s entry %s', v_name, page, i), s, v_id,
                CASE WHEN random() < 0.5 THEN i::text ELSE 'Plot ' || i END, pg_temp.name_of(a)));

      ELSIF sc = 'H' THEN
        a  := pg_temp.person('M', v_id);
        b  := pg_temp.person(CASE WHEN random() < 0.5 THEN 'F' ELSE 'M' END, v_id);
        s  := pg_temp.rdate('1980-01-01', '1999-12-31');
        e  := pg_temp.rdate('2008-01-01', '2021-12-31');
        r1 := pg_temp.right_(p_id, 'CUSTOMARY_ALLOCATION', 'VILLAGE_HEAD', s, e);
        PERFORM pg_temp.hold(r1, a, 1, 1, 'HOLDER');
        PERFORM pg_temp.cite(r1, pg_temp.doc('ALLOCATION_BOOK_ENTRY',
                format('%s allocation book p.%s entry %s', v_name, page, i), s, v_id, i::text, pg_temp.name_of(a)));
        r2 := pg_temp.right_(p_id, 'INHERITANCE', 'VILLAGE_HEAD', e, NULL);
        PERFORM pg_temp.hold(r2, b, 1, 1, 'HEIR');
        PERFORM pg_temp.cite(r2, pg_temp.doc('ALLOCATION_BOOK_ENTRY',
                format('%s allocation book p.%s entry %s (inheritance)', v_name, page, i), e, v_id, i::text, pg_temp.name_of(b)));

      ELSIF sc = 'T' THEN
        a  := pg_temp.person('M', v_id);
        s  := pg_temp.rdate('1990-01-01', '2005-12-31');
        e  := pg_temp.rdate('2012-01-01', '2020-12-31');
        r1 := pg_temp.right_(p_id, 'CUSTOMARY_ALLOCATION', 'VILLAGE_HEAD', s, e);
        PERFORM pg_temp.hold(r1, a, 1, 1, 'HOLDER');
        PERFORM pg_temp.cite(r1, pg_temp.doc('ALLOCATION_BOOK_ENTRY',
                format('%s allocation book p.%s entry %s', v_name, page, i), s, v_id, i::text, pg_temp.name_of(a)));
        r2 := pg_temp.right_(p_id, 'RDC_PERMIT', 'GRDC', e, NULL);
        PERFORM pg_temp.hold(r2, a, 1, 1, 'HOLDER');
        PERFORM pg_temp.cite(r2, pg_temp.doc('RDC_PERMIT',
                format('GRDC/W4/PERMIT/%s/%s', extract(year FROM e)::int, 200 + i), e, v_id, NULL, NULL));

      ELSIF sc = 'I' THEN
        a  := pg_temp.person(CASE WHEN random() < 0.3 THEN 'F' ELSE 'M' END, v_id);
        s  := pg_temp.rdate('2014-01-01', '2025-12-31');
        r1 := pg_temp.right_(p_id, 'INFORMAL_PURCHASE', 'NONE', s, NULL);
        PERFORM pg_temp.hold(r1, a, 1, 1, 'CLAIMANT');
        IF random() < 0.7 THEN
          PERFORM pg_temp.cite(r1, pg_temp.doc('AFFIDAVIT',
                  format('Affidavit of purchase, %s homestead %s', v_name, i), s, v_id, i::text, pg_temp.name_of(a)));
        END IF;   -- otherwise: a claim with no evidence on file (flagged)

      ELSIF sc = 'U' THEN
        a  := pg_temp.person(CASE WHEN random() < 0.4 THEN 'F' ELSE 'M' END, v_id);
        r1 := pg_temp.right_(p_id, 'UNDOCUMENTED_OCCUPATION', 'NONE', pg_temp.rdate('2005-01-01', '2024-12-31'), NULL);
        PERFORM pg_temp.hold(r1, a, 1, 1, 'CLAIMANT');
        PERFORM pg_temp.cite(r1, pg_temp.doc('FIELD_SURVEY',
                format('Ward 4 field survey 2026, %s form %s', v_name, i), DATE '2026-08-15', v_id, i::text, NULL));

      ELSIF sc = 'D' THEN
        a  := pg_temp.person('M', v_id);
        b  := pg_temp.person(CASE WHEN random() < 0.5 THEN 'F' ELSE 'M' END, v_id);
        r1 := pg_temp.right_(p_id, 'CUSTOMARY_ALLOCATION', 'VILLAGE_HEAD', s, NULL);
        PERFORM pg_temp.hold(r1, a, 1, 1, 'HOLDER');
        PERFORM pg_temp.cite(r1, pg_temp.doc('ALLOCATION_BOOK_ENTRY',
                format('%s allocation book p.%s entry %s', v_name, page, i), s, v_id, i::text, pg_temp.name_of(a)));
        r2 := pg_temp.right_(p_id, 'INFORMAL_PURCHASE', 'NONE', pg_temp.rdate('2019-01-01', '2025-12-31'), NULL);
        PERFORM pg_temp.hold(r2, b, 1, 1, 'CLAIMANT');
        PERFORM pg_temp.cite(r2, pg_temp.doc('AFFIDAVIT',
                format('Affidavit of purchase, %s homestead %s', v_name, i), NULL, v_id, i::text, pg_temp.name_of(b)));
      END IF;
      -- 'N': nothing recorded. An empty rrr set is a true statement.
    END LOOP;

    -- village extent = hull of its homesteads plus 40 m
    UPDATE lis.village
       SET geom = (SELECT ST_Multi(ST_Buffer(ST_ConvexHull(ST_Collect(p.geom)), 40))
                     FROM lis.parcel p WHERE p.village_id = v_id)
     WHERE village_id = v_id;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Restrictions (from the household survey categories)
-- ---------------------------------------------------------------------
INSERT INTO lis.rrr (parcel_id, rrr_kind, rrr_type, recognised_by, start_date, note)
SELECT p.parcel_id, 'RESTRICTION', x.t, 'GRDC', DATE '2005-01-01', x.note
  FROM (VALUES ('GRD-W4CRD-00003','WETLAND',             'Vlei on the eastern side'),
               ('GRD-W4CRD-00007','WETLAND',             'Seasonal wetland'),
               ('GRD-W4MUR-00002','POWERLINE_SERVITUDE', 'ZESA line crosses the plot'),
               ('GRD-W4MUR-00009','POWERLINE_SERVITUDE', 'ZESA line crosses the plot'),
               ('GRD-W4GUK-00004','ROAD_RESERVE',        'Road widening reserve')) AS x(upi, t, note)
  JOIN lis.parcel p ON p.upi = x.upi;

-- ---------------------------------------------------------------------
-- Allocation-book entries that match no homestead on the ground
-- ---------------------------------------------------------------------
INSERT INTO lis.source_document (doc_type, reference, issued_on, village_id,
                                 homestead_ref_raw, holder_name_raw, captured_by)
SELECT 'ALLOCATION_BOOK_ENTRY', x.ref, x.d::date, v.village_id, x.raw, x.who, 'seed:synthetic-generator'
  FROM (VALUES ('GUK','Gukwe allocation book p.90 entry 14',       '2011-05-02','14',                         'Tendekai Zhou'),
               ('CRZ','Chiroodza allocation book p.91 entry 15',   '2016-09-20','Plot 15',                    'Rumbidzai Nhamo'),
               ('MAR','Maro allocation book p.92 entry 3',         '2003-03-11','unnumbered (near borehole)', 'Garikai Shumba'),
               ('CRD','Chirodzero allocation book p.93 entry 16',  '2019-07-01','16',                         'Sekai Mutandwa')
       ) AS x(vcode, ref, d, raw, who)
  JOIN lis.village v ON v.code = x.vcode;

-- ---------------------------------------------------------------------
-- The council's levy register, as found: references written several
-- ways, some homesteads missing, some accounts for homesteads that do
-- not exist. Loaded UNMATCHED; matching is the reconciliation step.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record; n int := 0; u float8; v_ref text; v_name text;
BEGIN
  PERFORM setseed(0.1717);
  FOR r IN
    SELECT p.parcel_id, p.village_id, p.homestead_no,
           (SELECT pa.full_name
              FROM lis.rrr x JOIN lis.party_rrr pr ON pr.rrr_id = x.rrr_id
              JOIN lis.party pa ON pa.party_id = pr.party_id
             WHERE x.parcel_id = p.parcel_id AND x.rrr_kind = 'RIGHT' AND x.end_date IS NULL
             ORDER BY x.start_date, pr.role LIMIT 1) AS holder
      FROM lis.parcel p
     ORDER BY p.upi
  LOOP
    CONTINUE WHEN r.holder IS NULL;          -- nobody to bill
    CONTINUE WHEN random() > 0.78;           -- occupied but never put on the levy register
    n := n + 1;
    u := random();
    v_ref := CASE WHEN u < 0.60 THEN r.homestead_no::text
                  WHEN u < 0.78 THEN 'Hse ' || r.homestead_no
                  WHEN u < 0.88 THEN 'No. 0' || r.homestead_no
                  WHEN u < 0.94 THEN r.homestead_no || 'A'
                  ELSE r.homestead_no || ' (old)' END;
    v_name := CASE WHEN random() < 0.2
                   THEN left(r.holder, 1) || '. ' || split_part(r.holder, ' ', 2)
                   ELSE r.holder END;
    INSERT INTO lis.levy_account (account_no, village_id, homestead_ref_raw, payer_name_raw)
    VALUES ('GRDC-L-' || lpad(n::text, 5, '0'), r.village_id, v_ref, v_name);
  END LOOP;

  -- accounts for homesteads that are not on the ground
  INSERT INTO lis.levy_account (account_no, village_id, homestead_ref_raw, payer_name_raw)
  SELECT 'GRDC-L-' || lpad((n + k)::text, 5, '0'), v.village_id, x.raw, x.who
    FROM (VALUES (1,'GUK','18','P. Chigumba'),
                 (2,'MUR','Hse 21','Givemore Kanengoni'),
                 (3,'CRZ','19','Memory Zinyama'),
                 (4,'MAR','17','T. Makuvaza')) AS x(k, vcode, raw, who)
    JOIN lis.village v ON v.code = x.vcode;
END $$;

COMMIT;

ANALYZE;

-- Quick confirmation
SELECT 'villages' AS item, count(*) FROM lis.village
UNION ALL SELECT 'homesteads', count(*) FROM lis.parcel
UNION ALL SELECT 'parties', count(*) FROM lis.party
UNION ALL SELECT 'current rights', count(*) FROM lis.rrr WHERE rrr_kind = 'RIGHT' AND end_date IS NULL
UNION ALL SELECT 'levy accounts', count(*) FROM lis.levy_account
UNION ALL SELECT 'source documents', count(*) FROM lis.source_document;
