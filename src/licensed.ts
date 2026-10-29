// A system known only by its FCC license: licensed (the map's "licensed, not
// shared yet" rings), but no one has shared it. The directory shows it as it
// shows any system (read.ts SystemView, under the ID fcc_<call sign>: ids.ts),
// with what a license can't say left out: its sites are the license's base and
// repeater stations (stations.ts), each with the frequencies licensed there,
// and its licenses are those frequencies'. Which is its control channel, its
// identity and its talkgroups come from the air. Its page, its bundle for
// Trunk Recorder Pro (whose survey finds it by its licenses) and its SDR plan
// are a shared system's. A license with no station listed (a state's
// statewide one: stations.ts unsited) is a system with no sites: who holds it,
// and that it's licensed statewide.

import type { Db } from "./db.ts";
import { named, type Where } from "./explore.ts";
import { licensedId } from "./ids.ts";
import { licensedKind } from "./kinds.ts";
import type { Places } from "./places.ts";
import type { SiteView, SystemView } from "./read.ts";
import { type FccRow, rowsOf, spotKey, unsited } from "./stations.ts";

/** On the 6.25 kHz channel raster, as a system's licenses are kept. */
const raster = (hz: number) => Math.round(hz / 6250) * 6250;
const round = (v: number) => Math.round(v * 1e4) / 1e4;
const max = (rows: FccRow[], f: (r: FccRow) => number | null) => rows.reduce<number | null>((m, r) => (f(r) == null ? m : Math.max(m ?? 0, f(r)!)), null);

/** The system licensed to `callSign` (null: no active license has a base or repeater station, or no station at all), and where its stations are. */
export async function licensedSystem(db: Db, fcc: Db, places: Places | undefined, callSign: string): Promise<{ system: SystemView; where: Where } | null> {
  const rows = await rowsOf(fcc, [callSign]);
  const id = licensedId(callSign);
  if (!rows.length) {
    const [u] = await unsited(fcc, "u.call_sign = ?", [callSign]);
    if (!u) return null;
    return {
      system: {
        id, rev: 0, type: "", name: "", licensee: u.licensee_name ?? "", wacn: null, sysId: null, status: "licensed", mergedInto: null,
        lat: null, lon: null, createdAt: 0, updatedAt: 0, sites: [], licenses: {}, talkgroupCount: 0,
      },
      where: { transmitters: [], placements: [] },
    };
  }
  const licensee = rows[0].licensee_name ?? "";
  const bySpot = new Map<string, FccRow[]>();
  for (const r of rows) bySpot.set(spotKey(r.lat, r.lon), [...(bySpot.get(spotKey(r.lat, r.lon)) ?? []), r]);
  // Its sites: each spot, with the most frequencies first.
  const spots = [...bySpot.values()]
    .map((rs) => ({ rs, hz: [...new Set(rs.map((r) => raster(r.freq_center_hz)))].sort((a, b) => a - b) }))
    .sort((a, b) => b.hz.length - a.hz.length || a.rs[0].lat - b.rs[0].lat);
  // Each named by where the license says it is ("GW HOSPITAL"), else its city; a name taken, numbered ("ARLINGTON 2").
  const taken = new Map<string, number>();
  const nameOf = (r: FccRow) => {
    const base = r.location_name || r.location_city || "";
    const n = (taken.get(base) ?? 0) + 1;
    taken.set(base, n);
    return n > 1 && base ? `${base} ${n}` : base;
  };
  const sites: SiteView[] = spots.map(({ rs, hz }, i) => ({
    id: `${id}-${i + 1}`, name: nameOf(rs[0]), rfss: null, site: null, nac: null, status: "licensed", modulation: "", bandplan: null,
    lat: round(rs[0].lat), lon: round(rs[0].lon), controlChannelsHz: [], voiceChannelsHz: [], licensedHz: hz, neighbours: [], firstHeard: null, lastHeard: null,
  }));
  const licenses: SystemView["licenses"] = {};
  for (const hz of spots.flatMap((s) => s.hz)) licenses[String(hz)] = { callSign, name: licensee, source: "lookup" };
  const transmitters = [];
  for (const [i, { rs }] of spots.entries()) {
    const r = rs[0];
    const w = places && r.location_state ? await places.at(r.location_state, r.lat, r.lon) : { state: r.location_state ?? "", county: "", place: "" };
    transmitters.push({
      site: sites[i].id, callSign, licensee, lat: r.lat, lon: r.lon, heightM: max(rs, (x) => x.structure_height_m), erpW: max(rs, (x) => x.power_erp_w), freqHz: r.freq_center_hz,
      state: w.state, county: w.county, place: w.place,
    });
  }
  return {
    system: {
      id, rev: 0,
      // What its licensed emissions say it likely is (kinds.ts: "analog" and "" too).
      type: licensedKind(rows.map((r) => r.emissions)),
      name: "", licensee, wacn: null, sysId: null, status: "licensed", mergedInto: null,
      lat: round(sites.reduce((a, s) => a + s.lat!, 0) / sites.length), lon: round(sites.reduce((a, s) => a + s.lon!, 0) / sites.length),
      createdAt: 0, updatedAt: 0, sites, licenses, talkgroupCount: 0,
    },
    where: { transmitters: await named(db, transmitters), placements: [] },
  };
}
