// Licensed base and repeater stations (FCC station class FB…: not mobiles or
// control stations), as ArgusRF's FCC database has them: what placing a
// shared system's sites (place.ts), the map's licensed layer (explore.ts) and
// a system known only by its license (licensed.ts) all read, one way.

import { type Db, marks } from "./db.ts";

export interface FccRow {
  call_sign: string;
  licensee_name: string | null;
  freq_center_hz: number;
  lat: number;
  lon: number;
  structure_height_m: number | null;
  power_erp_w: number | null;
  class_station_code: string | null;
  location_state: string | null;
  /** What the license calls where it is ("GW HOSPITAL"), and its city. */
  location_name: string | null;
  location_city: string | null;
  /** Every emission licensed on the frequency there, comma separated. */
  emissions: string | null;
}

export const COLS = "call_sign, licensee_name, freq_center_hz, lat, lon, structure_height_m, power_erp_w, class_station_code, location_state, location_name, location_city, COALESCE(emissions, emission_designator) AS emissions";
/** An active license's base or repeater station. (`+`: never by a status index; on D1, with no statistics, one read the whole table.) */
export const BASE = "class_station_code LIKE 'FB%' AND +license_status = 'A'";

/** The stations of call signs `callSigns` (at most 50). */
export async function rowsOf(fcc: Db, callSigns: string[]): Promise<FccRow[]> {
  const some = [...new Set(callSigns)].slice(0, 50);
  return some.length ? fcc.all<FccRow>(`SELECT ${COLS} FROM transmitter WHERE call_sign IN (${marks(some.length)}) AND ${BASE} ORDER BY freq_center_hz`, some) : [];
}

/** The stations licensed within `halfHz` of `hz`. */
export function rowsOn(fcc: Db, hz: number, halfHz: number): Promise<FccRow[]> {
  return fcc.all<FccRow>(`SELECT ${COLS} FROM transmitter WHERE freq_center_hz BETWEEN ? AND ? AND ${BASE}`, [hz - halfHz, hz + halfHz]);
}

/** A spot: a station's location to 4 decimal places (~10 m). One tower can hold several call signs' channels. */
export const spotKey = (lat: number, lon: number) => `${lat.toFixed(4)}|${lon.toFixed(4)}`;
