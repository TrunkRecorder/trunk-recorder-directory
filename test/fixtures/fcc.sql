-- A small FCC database for tests and offline runs: ArgusRF's schema (src/fcc/schema.sql)
-- with real rows copied from production (D1 `argus`, 2026-10-21): DC Fire and EMS,
-- Arlington County and WMATA licenses near Washington, DC. Real rows, so the same
-- end-to-end assertions hold offline, on staging and on production.

-- ArgusRF's FCC ULS database (the D1 database `argus`), as its ingest builds it:
-- copied from robotastic/argusrf ingest/src/db.ts (SCHEMA + INDEXES) at 856f4c9.
-- The FCC lookup reads it; tests and local runs build a small one from this.
-- If ArgusRF changes its schema, copy it again (test/fcc.test.ts checks the columns the lookup reads).

-- Provenance: every response must be traceable to a dated FCC pull (spec §5.6).
CREATE TABLE source_file (
  id               INTEGER PRIMARY KEY,
  filename         TEXT NOT NULL,
  url              TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  downloaded_at    TEXT NOT NULL,
  fcc_published_at TEXT,
  record_count     INTEGER
);

-- Rows the parser could not read. Expected to be ~3 in 21M (see
-- docs/data-layer-findings.md §3); the validation gate fails the build if the
-- rate climbs, which is the signal that the layout changed.
CREATE TABLE parse_reject (
  id             INTEGER PRIMARY KEY,
  source_file_id INTEGER REFERENCES source_file(id),
  record_type    TEXT NOT NULL,
  line_number    INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  raw            TEXT
);

-- The query target (spec §3.2). Denormalised on purpose: one row per
-- (license, location, antenna, frequency, emission).
--
-- Two tables of the SAME shape:
--   transmitter          -- active licenses (license_status = 'A'). The hot path.
--   transmitter_inactive -- cancelled/expired/terminated. Queried only as a
--                            fallback when no active license overlaps the band,
--                            so a signal on a channel whose licenses all lapsed
--                            (common in paging) still names who *was* there.
-- Kept separate rather than as one status-flagged table so the active table's
-- size, indexes and D1 footprint are unchanged — the inactive set is ~20x
-- larger for some services and would otherwise bloat every active lookup.
-- One column list feeds both, so the two can never drift.
CREATE TABLE transmitter (
  id                  INTEGER PRIMARY KEY,

  source              TEXT NOT NULL,        -- 'uls'
  source_file_id      INTEGER REFERENCES source_file(id),
  usi                 TEXT,
  call_sign           TEXT,
  location_number     INTEGER,
  antenna_number      INTEGER,

  -- Frequency. Integer Hz, always. Never REAL, never MHz.
  freq_center_hz      INTEGER NOT NULL,
  freq_lower_hz       INTEGER NOT NULL,
  freq_upper_hz       INTEGER NOT NULL,
  bandwidth_hz        INTEGER,
  bandwidth_source    TEXT,                 -- 'emission' | 'upper_band' | 'service_default' | 'fallback'
  emission_designator TEXT,

  -- Power. ULS ships TPO and ERP in adjacent, easily-transposed columns; keep
  -- both rather than collapsing to one and losing which is which.
  power_output_w      REAL,
  power_erp_w         REAL,

  -- Geography.
  lat                 REAL,
  lon                 REAL,
  location_kind       TEXT NOT NULL,        -- 'fixed' | 'mobile_area' | 'market' | 'address'
  location_confidence TEXT NOT NULL,        -- 'exact' | 'approximate' | 'area' | 'address_only'
  area_radius_m       REAL,

  -- Structure, straight off the LO row (the spec expected an ASR join for this).
  tower_registration_number TEXT,
  structure_height_m  REAL,
  structure_type      TEXT,
  location_name       TEXT,
  location_city       TEXT,
  location_state      TEXT,

  -- Licensee.
  licensee_name       TEXT,
  frn                 TEXT,

  -- Status.
  radio_service_code  TEXT,
  radio_service_desc  TEXT,
  license_status      TEXT,
  grant_date          TEXT,
  expired_date        TEXT
);
CREATE TABLE transmitter_inactive (
  id                  INTEGER PRIMARY KEY,

  source              TEXT NOT NULL,        -- 'uls'
  source_file_id      INTEGER REFERENCES source_file(id),
  usi                 TEXT,
  call_sign           TEXT,
  location_number     INTEGER,
  antenna_number      INTEGER,

  -- Frequency. Integer Hz, always. Never REAL, never MHz.
  freq_center_hz      INTEGER NOT NULL,
  freq_lower_hz       INTEGER NOT NULL,
  freq_upper_hz       INTEGER NOT NULL,
  bandwidth_hz        INTEGER,
  bandwidth_source    TEXT,                 -- 'emission' | 'upper_band' | 'service_default' | 'fallback'
  emission_designator TEXT,

  -- Power. ULS ships TPO and ERP in adjacent, easily-transposed columns; keep
  -- both rather than collapsing to one and losing which is which.
  power_output_w      REAL,
  power_erp_w         REAL,

  -- Geography.
  lat                 REAL,
  lon                 REAL,
  location_kind       TEXT NOT NULL,        -- 'fixed' | 'mobile_area' | 'market' | 'address'
  location_confidence TEXT NOT NULL,        -- 'exact' | 'approximate' | 'area' | 'address_only'
  area_radius_m       REAL,

  -- Structure, straight off the LO row (the spec expected an ASR join for this).
  tower_registration_number TEXT,
  structure_height_m  REAL,
  structure_type      TEXT,
  location_name       TEXT,
  location_city       TEXT,
  location_state      TEXT,

  -- Licensee.
  licensee_name       TEXT,
  frn                 TEXT,

  -- Status.
  radio_service_code  TEXT,
  radio_service_desc  TEXT,
  license_status      TEXT,
  grant_date          TEXT,
  expired_date        TEXT
);

CREATE TABLE radio_service (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

-- The money index. A frequency lookup is answered by a bounded range scan on
-- freq_lower_hz (see shared/src/query.ts), so this ordering is what makes the
-- whole thing work without an R-tree.
CREATE INDEX idx_tx_lower  ON transmitter(freq_lower_hz, freq_upper_hz);
CREATE INDEX idx_tx_center ON transmitter(freq_center_hz);
CREATE INDEX idx_tx_call   ON transmitter(call_sign);
CREATE INDEX idx_tx_status ON transmitter(license_status);
-- Spatial filtering rides along on the frequency scan; this only helps the
-- "what is near me on any frequency" case.
CREATE INDEX idx_tx_latlon ON transmitter(lat, lon);

-- The inactive fallback is the same bounded range scan, so it needs the same
-- money index. call/latlon are not indexed here — the inactive table is only
-- ever reached by frequency, never browsed.
CREATE INDEX idx_txi_lower ON transmitter_inactive(freq_lower_hz, freq_upper_hz);

INSERT INTO source_file (id, filename, url, sha256, downloaded_at, fcc_published_at, record_count) VALUES
  (1, 'l_LMpriv.zip', 'https://data.fcc.gov/download/pub/uls/complete.07242026/l_LMpriv.zip', 'a33eba8f3ec78eea944ca720ea363827261ae6ed31f0e5cada61220e84e94a20', '2026-07-26T11:30:00.175Z', 'Sun Jul 12 15:14:58 EDT 2026', 5647787),
  (2, 'l_LMcomm.zip', 'https://data.fcc.gov/download/pub/uls/complete.07242026/l_LMcomm.zip', '87ef0123e1745d673c2075af8f47564df20dc68d9e23837e883574f9f85a7f84', '2026-07-26T11:30:36.986Z', 'Sun Jul 12 15:21:01 EDT 2026', 7879396),
  (3, 'l_micro.zip', 'https://data.fcc.gov/download/pub/uls/complete.07242026/l_micro.zip', '42af44424b0c52b140cae5eff91c192364d5cc856c8115d1ab2104640e5710f6', '2026-07-26T11:30:53.603Z', 'Sun Jul 12 15:29:21 EDT 2026', 10817481),
  (4, 'l_paging.zip', 'https://data.fcc.gov/download/pub/uls/complete.07242026/l_paging.zip', '0a20f5d17df9b763c286e63a73eaba6669aa2f1b93111214e1650f009446ea7a', '2026-07-26T11:31:04.421Z', 'Sun Jul 12 15:42:41 EDT 2026', 10859531);
INSERT INTO radio_service (code, description) VALUES
  ('YE', 'PubSafty/SpecEmer/PubSaftyNtlPlan,806-817/851-862MHz,Trunked'),
  ('YG', 'Industrial/Business Pool, Trunked');
INSERT INTO transmitter (id, source, source_file_id, usi, call_sign, location_number, antenna_number, freq_center_hz, freq_lower_hz, freq_upper_hz, bandwidth_hz, bandwidth_source, emission_designator, power_output_w, power_erp_w, lat, lon, location_kind, location_confidence, area_radius_m, tower_registration_number, structure_height_m, structure_type, location_name, location_city, location_state, licensee_name, frn, radio_service_code, radio_service_desc, license_status, grant_date, expired_date) VALUES
  (549890, 'uls', 1, '2443822', 'WPVX388', 1, 2, 489087500, 489077500, 489097500, 20000, 'emission', '20K0F2D', 91.2, 175, 38.89833333333333, -77.01777777777778, 'fixed', 'exact', NULL, NULL, 54.3, 'B', NULL, 'Washington', 'DC', 'Washington Metropolitan Area Transit Authority', '0004675385', 'YG', NULL, 'A', '06/08/2022', '08/29/2032'),
  (549912, 'uls', 1, '2443822', 'WPVX388', 2, 1, 489087500, 489077500, 489097500, 20000, 'emission', '20K0F2D', 48, 400, 39.01488888888889, -76.77161111111111, 'fixed', 'exact', NULL, NULL, 59, 'TOWER', NULL, 'Jericho Park', 'MD', 'Washington Metropolitan Area Transit Authority', '0004675385', 'YG', NULL, 'A', '06/08/2022', '08/29/2032'),
  (549950, 'uls', 1, '2443822', 'WPVX388', 3, 1, 489087500, 489077500, 489097500, 20000, 'emission', '20K0F2D', 33.2, 300, 39.126111111111115, -76.81027777777777, 'fixed', 'exact', NULL, '1214905', 121.9, 'TOWER', NULL, 'Savage', 'MD', 'Washington Metropolitan Area Transit Authority', '0004675385', 'YG', NULL, 'A', '06/08/2022', '08/29/2032'),
  (549972, 'uls', 1, '2443822', 'WPVX388', 4, 1, 489087500, 489077500, 489097500, 20000, 'emission', '20K0F2D', 46, 100, 38.84444444444445, -76.96975, 'fixed', 'exact', NULL, '1220365', 97.5, 'TOWER', NULL, 'Suitland', 'MD', 'Washington Metropolitan Area Transit Authority', '0004675385', 'YG', NULL, 'A', '06/08/2022', '08/29/2032'),
  (249199, 'uls', 1, '1302193', 'KNJU834', 2, 1, 857987500, 857983450, 857991550, 8100, 'emission', '8K10F1D', 100, 210, 38.84861111111111, -76.98647222222222, 'fixed', 'exact', NULL, '1059783', 76.2, 'LTOWER', 'STE', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '06/14/2024', '09/03/2034'),
  (249204, 'uls', 1, '1302193', 'KNJU834', 3, 1, 857987500, 857983450, 857991550, 8100, 'emission', '8K10F1D', 100, 309, 38.91138888888889, -77.07588888888888, 'fixed', 'exact', NULL, 'N/A', 38.4, 'B', 'GT', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '06/14/2024', '09/03/2034'),
  (249209, 'uls', 1, '1302193', 'KNJU834', 4, 1, 857987500, 857983450, 857991550, 8100, 'emission', '8K10F1D', 100, 150, 38.96222222222222, -77.02638888888889, 'fixed', 'exact', NULL, '1036576', 232, 'LTOWER', '4D', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '06/14/2024', '09/03/2034'),
  (249214, 'uls', 1, '1302193', 'KNJU834', 6, 1, 857987500, 857983450, 857991550, 8100, 'emission', '8K10F1D', 100, 410, 38.884166666666665, -76.93227777777778, 'fixed', 'exact', NULL, '1295422', 60.7, 'MTOWER', 'FJ', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '06/14/2024', '09/03/2034'),
  (573502, 'uls', 1, '2520309', 'WPXT459', 1, 1, 857987500, 857983450, 857991550, 8100, 'emission', '8K10F1D', 100, 220, 38.90163888888889, -77.04855555555555, 'fixed', 'exact', NULL, NULL, 50.4, 'BANT', 'GW HOSPITAL', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '07/14/2023', '06/06/2033'),
  (573510, 'uls', 1, '2520309', 'WPXT459', 3, 1, 857987500, 857983450, 857991550, 8100, 'emission', '8K10F1E', 100, 310, 38.89486111111111, -77.01555555555555, 'fixed', 'exact', NULL, NULL, 50.6, 'BANT', 'JUDICIARY SQUARE', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '07/14/2023', '06/06/2033'),
  (573518, 'uls', 1, '2520309', 'WPXT459', 4, 1, 857987500, 857983450, 857991550, 8100, 'emission', '8K10F1D', 100, 158, 38.943888888888885, -77.06438888888889, 'fixed', 'exact', NULL, NULL, 24.2, 'BANT', 'UDC BUILDING', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '07/14/2023', '06/06/2033'),
  (573526, 'uls', 1, '2520309', 'WPXT459', 5, 1, 857987500, 857983450, 857991550, 8100, 'emission', '8K10F1D', 100, 214, 38.93630555555555, -77.10891666666666, 'fixed', 'exact', NULL, NULL, 41, 'BANT', 'SIBLEY HOSPITAL', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '07/14/2023', '06/06/2033'),
  (573534, 'uls', 1, '2520309', 'WPXT459', 6, 1, 857987500, 857983450, 857991550, 8100, 'emission', '8K10F1D', 100, 282, 38.92758333333333, -76.98027777777779, 'fixed', 'exact', NULL, NULL, 52, 'BANT', '1700 RHODE ISLAND', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '07/14/2023', '06/06/2033'),
  (573542, 'uls', 1, '2520309', 'WPXT459', 8, 1, 857987500, 857983450, 857991550, 8100, 'emission', '8K10F1D', 100, 250, 38.92191666666666, -77.01583333333333, 'fixed', 'exact', NULL, NULL, 60.7, 'LTOWER', 'MCMILLAN', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '07/14/2023', '06/06/2033'),
  (247369, 'uls', 1, '1302163', 'KNIQ704', 2, 1, 860437500, 860427500, 860447500, 20000, 'emission', '20K0F3E', 150, 825, 38.90222222222222, -77.12138888888889, 'fixed', 'exact', NULL, NULL, 49, 'B', NULL, 'ARLINGTON', 'VA', 'Arlington County Department of Public Safety Communications and Emergency Management', '0002036101', 'YE', NULL, 'A', '02/02/2022', '04/14/2032'),
  (247427, 'uls', 1, '1302163', 'KNIQ704', 3, 1, 860437500, 860427500, 860447500, 20000, 'emission', '20K0F3E', 75, 240, 38.87288888888889, -77.15858333333334, 'fixed', 'exact', NULL, NULL, 49, NULL, NULL, 'FALLS CHURCH', 'VA', 'Arlington County Department of Public Safety Communications and Emergency Management', '0002036101', 'YE', NULL, 'A', '02/02/2022', '04/14/2032'),
  (247446, 'uls', 1, '1302163', 'KNIQ704', 4, 1, 860437500, 860427500, 860447500, 20000, 'emission', '20K0F3E', 150, 168, 38.86205555555556, -77.06025, 'fixed', 'exact', NULL, NULL, 64, NULL, NULL, 'ARLINGTON', 'VA', 'Arlington County Department of Public Safety Communications and Emergency Management', '0002036101', 'YE', NULL, 'A', '02/02/2022', '04/14/2032'),
  (247539, 'uls', 1, '1302163', 'KNIQ704', 5, 1, 860437500, 860427500, 860447500, 20000, 'emission', '20K0F3E', 150, 1000, 38.89, -77.08527777777778, 'fixed', 'exact', NULL, NULL, 46, 'B', NULL, 'ARLINGTON', 'VA', 'Arlington County Department of Public Safety Communications and Emergency Management', '0002036101', 'YE', NULL, 'A', '02/02/2022', '04/14/2032'),
  (247757, 'uls', 1, '1302163', 'KNIQ704', 7, 1, 860437500, 860427500, 860447500, 20000, 'emission', '20K0F3E', 100, 371, 38.881, -77.10913888888888, 'fixed', 'exact', NULL, '1251723', 77.1, 'BPIPE', NULL, 'ARLINGTON', 'VA', 'Arlington County Department of Public Safety Communications and Emergency Management', '0002036101', 'YE', NULL, 'A', '02/02/2022', '04/14/2032'),
  (247775, 'uls', 1, '1302163', 'KNIQ704', 8, 1, 860437500, 860427500, 860447500, 20000, 'emission', '20K0F3E', 100, 417, 38.83983333333334, -77.08749999999999, 'fixed', 'exact', NULL, NULL, 46, 'B', NULL, 'ARLINGTON', 'VA', 'Arlington County Department of Public Safety Communications and Emergency Management', '0002036101', 'YE', NULL, 'A', '02/02/2022', '04/14/2032'),
  (246079, 'uls', 1, '1302167', 'KNJA391', 2, 1, 859037500, 859033450, 859041550, 8100, 'emission', '8K10F1D', 100, 210, 38.84861111111111, -76.98647222222222, 'fixed', 'exact', NULL, '1059783', 76.2, 'LTOWER', 'STE', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '02/14/2024', '05/07/2034'),
  (246255, 'uls', 1, '1302170', 'KNJE616', 1, 1, 855212500, 855208450, 855216550, 8100, 'emission', '8K10F1D', 100, 150, 38.96222222222222, -77.02638888888889, 'fixed', 'exact', NULL, '1036576', 232, 'LTOWER', '4D', 'WASHINGTON', 'DC', 'DISTRICT OF COLUMBIA', '0007916521', 'YE', NULL, 'A', '06/14/2024', '09/03/2034');
