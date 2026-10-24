-- Who a system's licenses are held by, as twins.ts compares them (licenseeKey:
-- lower case, words sorted, "of"/"the" and punctuation left out), so a system
-- shared twice is found by its licensee: an index, not a scan of every system.
CREATE TABLE system_licensees (
  system_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (system_id, key)
);
CREATE INDEX system_licensees_key ON system_licensees (key);
