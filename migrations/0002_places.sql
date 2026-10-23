-- Where systems are: each site's transmitters as its FCC licenses place them,
-- the state, county and city (Census place) each is in, and those places'
-- names. src/place.ts fills them; the map, the drill-down and "near" read them.

-- A site's transmitters (a simulcast site has several), from the FCC licenses
-- that match its frequencies. Derived from the FCC data, so not revisioned:
-- placing a site again replaces them. (The site's own lat/lon, their centre,
-- is revisioned.)
CREATE TABLE site_transmitters (
  site_id TEXT NOT NULL,
  call_sign TEXT NOT NULL,
  licensee TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  height_m REAL,                       -- the structure's, from the license
  erp_w REAL,                          -- the highest on the site's frequencies there
  freq_hz INTEGER,                     -- the control channel it was matched on
  station_class TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',      -- USPS code
  county TEXT NOT NULL DEFAULT '',     -- county GEOID (5 digits)
  place TEXT NOT NULL DEFAULT '',      -- Census place GEOID (7 digits), '' outside one
  at INTEGER NOT NULL,
  PRIMARY KEY (site_id, call_sign, lat, lon)
);
CREATE INDEX site_transmitters_state ON site_transmitters (state);
CREATE INDEX site_transmitters_county ON site_transmitters (county);
CREATE INDEX site_transmitters_place ON site_transmitters (place);
CREATE INDEX site_transmitters_latlon ON site_transmitters (lat, lon);
CREATE INDEX site_transmitters_call ON site_transmitters (call_sign);

-- How placing each site last went (and why not, when it didn't).
CREATE TABLE placements (
  site_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  method TEXT NOT NULL,                -- call_sign | fingerprint | none
  note TEXT NOT NULL DEFAULT '',
  freqs TEXT NOT NULL DEFAULT ''       -- the frequencies it was placed by (placed again when they change)
);

-- States, counties and Census places: names and a point inside each
-- (scripts/geo.ts makes the rows from the Census Bureau's boundary files).
CREATE TABLE places (
  geoid TEXT PRIMARY KEY,              -- USPS code for a state, else the Census GEOID
  kind TEXT NOT NULL,                  -- state | county | place
  state TEXT NOT NULL,
  name TEXT NOT NULL,                  -- "Arlington"
  full_name TEXT NOT NULL,             -- "Arlington County", "Arlington CDP"
  lat REAL, lon REAL
);
CREATE INDEX places_state ON places (state, kind);
CREATE INDEX places_name ON places (name);
