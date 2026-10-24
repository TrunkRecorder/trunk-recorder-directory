-- Where a recorder is is never kept: a system is where its licensed towers
-- are (site_transmitters). The cells recorders heard sites from go, and the
-- cell a share carried.
DROP TABLE IF EXISTS geo_cells;
ALTER TABLE observations DROP COLUMN cell;
