-- The directory's records, and their history.
--
-- Records are revisioned: every change to one is a revision (one field, before
-- and after) in a change set, and nothing is overwritten without one. Columns
-- named in src/store.ts as `stats` are evidence counters from the air (heard
-- counts, first/last heard) and change without revisions.
-- docs/design.md has the why.

CREATE TABLE systems (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                 -- p25 | smartnet | dmr | nxdn
  name TEXT NOT NULL DEFAULT '',
  wacn INTEGER, sys_id INTEGER,        -- P25 / SmartNet identity, as the air says it
  status TEXT NOT NULL DEFAULT 'active', -- active | merged | hidden | retired
  merged_into TEXT,
  lat REAL, lon REAL,                  -- a representative point (its sites')
  rev INTEGER NOT NULL DEFAULT 0,      -- not revisioned: the version itself
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  rfss INTEGER, site INTEGER, nac INTEGER,
  modulation TEXT NOT NULL DEFAULT '',
  bandplan TEXT NOT NULL DEFAULT '',   -- JSON, a SmartNet band plan in TRP's terms
  lat REAL, lon REAL, loc_source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'heard', -- heard | announced | merged | retired
  merged_into TEXT,
  first_heard INTEGER, last_heard INTEGER
);
CREATE INDEX sites_system ON sites (system_id);

-- A site's frequencies and what each is for.
CREATE TABLE site_freqs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  freq_hz INTEGER NOT NULL,
  use TEXT NOT NULL,                   -- control | voice
  first_heard INTEGER, last_heard INTEGER,
  grants INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX site_freqs_site ON site_freqs (site_id);

-- A site announcing another as its neighbour.
CREATE TABLE site_neighbours (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  neighbour_id TEXT NOT NULL,
  first_heard INTEGER, last_heard INTEGER
);
CREATE INDEX site_neighbours_site ON site_neighbours (site_id);

CREATE TABLE talkgroups (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  alpha TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', -- active | heard (not named yet) | merged | retired
  merged_into TEXT,
  first_heard INTEGER, last_heard INTEGER,
  grants INTEGER NOT NULL DEFAULT 0,
  encrypted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX talkgroups_system ON talkgroups (system_id, number);

-- Where each talkgroup is heard (not revisioned: evidence).
CREATE TABLE talkgroup_sites (
  talkgroup_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  grants INTEGER NOT NULL DEFAULT 0,
  first_heard INTEGER, last_heard INTEGER,
  PRIMARY KEY (talkgroup_id, site_id)
);
CREATE INDEX talkgroup_sites_site ON talkgroup_sites (site_id);

-- Who is licensed on a system's frequencies (TRP's `fcc` map).
CREATE TABLE fcc_licenses (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  freq_hz INTEGER NOT NULL,
  call_sign TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL                 -- user | air | lookup
);
CREATE INDEX fcc_licenses_system ON fcc_licenses (system_id, freq_hz);

-- What the air says, pointing at a record: how a share finds what it's of.
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  observations INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER, last_seen INTEGER
);
CREATE INDEX claims_key ON claims (key);
CREATE INDEX claims_record ON claims (record_id);

-- Where things are, by H3 cell (D1 has no spatial index).
CREATE TABLE geo_cells (
  cell TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source TEXT NOT NULL,                -- heard | fcc | announced
  strength REAL NOT NULL DEFAULT 1,
  last_seen INTEGER,
  PRIMARY KEY (cell, record_id, source)
);
CREATE INDEX geo_cells_record ON geo_cells (record_id);

-- A merged record's ID, to the one it went into.
CREATE TABLE redirects (
  id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL
);

-- Names and settings as asserted: each value, and who backs it.
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL
);
CREATE INDEX candidates_record ON candidates (record_id, field);

CREATE TABLE supporters (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  actor TEXT NOT NULL,                 -- r_… a recorder, a_… an account
  at INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  void INTEGER NOT NULL DEFAULT 0      -- superseded by the actor's later choice
);
CREATE INDEX supporters_candidate ON supporters (candidate_id);
CREATE INDEX supporters_actor ON supporters (actor);

CREATE TABLE locks (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX locks_record ON locks (record_id, field);

-- History.
CREATE TABLE changesets (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,            -- recorder | contributor | steward | admin | system
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- share | edit | merge | split | revert | lock | hide | retire
  observation_id TEXT,
  reverts_id TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX changesets_actor ON changesets (actor_id);

CREATE TABLE revisions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  changeset_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field TEXT NOT NULL,                 -- a column, or '*' for the whole record (made / removed)
  before TEXT,                         -- JSON; null: didn't exist
  after TEXT                           -- JSON; null: removed
);
CREATE INDEX revisions_changeset ON revisions (changeset_id);
CREATE INDEX revisions_record ON revisions (record_id, field);

-- Each version of a system: the change set that made it.
CREATE TABLE system_revs (
  system_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  changeset_id TEXT NOT NULL,
  PRIMARY KEY (system_id, rev)
);
CREATE INDEX system_revs_changeset ON system_revs (changeset_id);

-- Shares, as they came (the JSON in R2).
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  recorder_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  cell TEXT,
  system_id TEXT,
  base_rev INTEGER,
  r2_key TEXT,
  status TEXT NOT NULL,                -- applied | quarantined | rejected
  changeset_id TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX observations_recorder ON observations (recorder_id);

-- Recorders or accounts whose shares and support no longer count.
CREATE TABLE quarantined (
  actor TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE merge_proposals (
  id TEXT PRIMARY KEY,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  evidence TEXT NOT NULL,              -- JSON
  score REAL NOT NULL,
  status TEXT NOT NULL,                -- open | merged | rejected
  changeset_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX merge_proposals_pair ON merge_proposals (a_id, b_id);

-- Full-text search over names (rebuilt per system as it changes).
CREATE VIRTUAL TABLE search_fts USING fts5(record_id UNINDEXED, system_id UNINDEXED, kind UNINDEXED, text);
