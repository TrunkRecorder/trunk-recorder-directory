-- ArgusRF's FCC ULS database (the D1 database `argus`), as its ingest builds it:
-- copied from robotastic/argusrf ingest/src/db.ts (SCHEMA + INDEXES) at 03ea815.
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
  -- The station's class (FR.class_station_code), verbatim: FB a base, FB2 a
  -- mobile relay (repeater), FB4 a community repeater, FB6/FB7 a private
  -- carrier's, FB8 a centralized trunk relay, FX1 a control station, MO a
  -- mobile (MO8 a trunked one). Suffixes: C interconnect, T temporary,
  -- S stand-by, I itinerant (J/K/L: those with interconnect). Whether a
  -- system is trunked is mostly its radio service's ("..., Trunked").
  class_station_code  TEXT,
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
  -- The station's class (FR.class_station_code), verbatim: FB a base, FB2 a
  -- mobile relay (repeater), FB4 a community repeater, FB6/FB7 a private
  -- carrier's, FB8 a centralized trunk relay, FX1 a control station, MO a
  -- mobile (MO8 a trunked one). Suffixes: C interconnect, T temporary,
  -- S stand-by, I itinerant (J/K/L: those with interconnect). Whether a
  -- system is trunked is mostly its radio service's ("..., Trunked").
  class_station_code  TEXT,
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
