-- ZIP codes (the Census Bureau's ZIP Code Tabulation Areas): a point inside
-- each, for finding a place by its ZIP. scripts/geo.ts makes the rows.
CREATE TABLE zips (
  zip TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);
