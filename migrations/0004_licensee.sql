-- Who holds a system's licenses (the most of its transmitters'), derived when
-- it's placed (place.ts), so every list, search and export reads one value
-- instead of working it out itself. Not revisioned: it follows the FCC data.
ALTER TABLE systems ADD COLUMN licensee TEXT NOT NULL DEFAULT '';
UPDATE systems SET licensee = COALESCE((
  SELECT x.licensee FROM site_transmitters x JOIN sites s ON s.id = x.site_id
   WHERE s.system_id = systems.id AND x.licensee != ''
   GROUP BY x.licensee ORDER BY COUNT(*) DESC LIMIT 1), '');
