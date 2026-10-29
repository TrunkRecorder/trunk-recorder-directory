-- The state a point is in (explore.ts stateAt): the counties near it, by their
-- points, without reading every place.
CREATE INDEX places_kind_lat ON places (kind, lat);
