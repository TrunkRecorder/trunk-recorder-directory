// Exploring: by place (state → county → city), the map's layers, near a
// point, and licensed systems no one has shared — on real DC licenses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { latLngToCell } from "h3-js";
import { licensedCell, licensedKind, licensedShown, licensedSpots, parseTypes } from "../src/explore.ts";
import { fccSqlite } from "../src/sqlite.ts";
import { directory, obs, p25Site, recorder } from "./helpers.ts";

const dcfd = () =>
  p25Site(1, 3, 857_987_500, {
    wacn: 0xbee00, sysId: 0x445, controlChannelsHz: [855_462_500, 857_987_500],
    heard: { identity: { nac: 0x443, wacn: 0xbee00, sysId: 0x445, rfss: 1, site: 3 }, controlChannelHz: 857_987_500, voice: [{ freqHz: 769_906_250, grants: 4 }], neighbours: [], callSigns: [{ freqHz: 859_987_500, callSign: "KNJE616" }], good: 900, bad: 3 },
  });
const wmataSite = () => {
  const cc = [496_437_500, 490_862_500, 496_537_500, 490_787_500];
  return { controlChannelsHz: cc, heard: { controlChannelHz: cc[0], voice: [489_087_500, 489_512_500, 496_612_500].map((freqHz) => ({ freqHz, grants: 3 })), neighbours: [], callSigns: [], good: 500, bad: 2 } };
};

async function twoSystems() {
  const d = directory({ place: true });
  const a = await d.share(obs(recorder(), [dcfd()]));
  const s = wmataSite();
  const b = await d.share(obs(recorder(), [s], { system: { type: "smartnet", sites: [s] } }));
  return { d, dcfd: a.json.system as string, wmata: b.json.system as string };
}

test("types: a list of known ones, or all", () => {
  assert.deepEqual(parseTypes("p25,SmartNet,bogus"), ["p25", "smartnet"]);
  assert.equal(parseTypes(null).length, 5);
  assert.equal(parseTypes("").length, 5);
});

test("drill down: states, a state's counties and regional systems, a county's cities, a city's systems", async () => {
  const { d, dcfd, wmata } = await twoSystems();
  const all = (await d.get("/places")).json;
  const dc = all.states.find((s: any) => s.state === "DC");
  assert.equal(dc.name, "District of Columbia");
  assert.equal(dc.systems, 2);
  assert.deepEqual(dc.byType, { p25: 1, smartnet: 1 });
  assert.equal(all.unplaced, 0);
  // Filtered by type.
  assert.deepEqual((await d.get("/places?types=p25")).json.states.find((s: any) => s.state === "DC").byType, { p25: 1 });
  const st = (await d.get("/places/DC")).json;
  assert.deepEqual(st.counties.map((c: any) => [c.geoid, c.name, c.systems]), [["11001", "District of Columbia", 2]]);
  const c = (await d.get("/places/DC/11001")).json;
  assert.deepEqual(c.systems.map((s: any) => s.id).sort(), [dcfd, wmata].sort());
  assert.equal(c.systems.find((s: any) => s.id === dcfd).licensee, "DISTRICT OF COLUMBIA");
  assert.deepEqual(c.cities.map((x: any) => [x.geoid, x.name]), [["1150000", "Washington city"]]);
  const city = (await d.get("/places/DC/11001/1150000")).json;
  assert.equal(city.systems.length, 2);
  // Maryland: WMATA is there too (Prince George's, Montgomery).
  const md = (await d.get("/places/MD")).json;
  assert.ok(md.counties.some((x: any) => x.geoid === "24033"), JSON.stringify(md.counties));
  assert.equal((await d.get("/places/ZZ")).status, 404);
  assert.equal((await d.get("/places/DC/24033")).status, 404, "a county of another state");
});

test("the map: every placed site with its transmitters, and each county's count", async () => {
  const { d, dcfd, wmata } = await twoSystems();
  const sites = (await d.get("/map/sites")).json.sites;
  assert.equal(sites.length, 2);
  const s = sites.find((x: any) => x.system === dcfd);
  assert.equal(s.at.length, 10);
  assert.equal(s.name, "DC Fire and EMS");
  assert.match(sites.find((x: any) => x.system === wmata).name, /Metropolitan Area Transit/i, "named by its licensee until it has a name");
  assert.equal((await d.get("/map/sites?types=smartnet")).json.sites.length, 1);
  const counties = (await d.get("/map/counties")).json.counties;
  assert.equal(counties["11001"], 2);
  assert.equal((await d.get("/map/counties?types=dmr")).json.counties["11001"], undefined);
});

test("near a point: systems with a transmitter in range, nearest first, with their transmitters", async () => {
  const { d, dcfd } = await twoSystems();
  const r = (await d.get(`/nearby?cell=${latLngToCell(38.9, -77.03, 6)}&radiusKm=25`)).json;
  assert.equal(r.systems.length, 2);
  const s = r.systems.find((x: any) => x.id === dcfd);
  assert.ok(s.distanceKm < 5);
  assert.equal(s.bandMhz, 855.5);
  assert.equal(s.transmitters.length, 10);
  assert.ok(s.transmitters.every((t: any) => t.heightM > 0 && t.erpW > 0));
  // Far away: nothing.
  assert.equal((await d.get("/nearby?lat=39.74&lon=-104.99&radiusKm=50")).json.systems.length, 0);
  assert.equal((await d.get("/nearby")).status, 400);
});

test("licensed, not shared: every trunked base station licensed, by spot; and the call signs shared systems have", async () => {
  const { d } = await twoSystems();
  const all = await licensedSpots(fccSqlite());
  assert.ok(all.length > 50);
  assert.ok(all.every((x) => x.stationClass.startsWith("FB") && (/Trunked/.test(x.serviceDesc) || x.stationClass.startsWith("FB8"))), JSON.stringify(all.slice(0, 2)));
  assert.equal(new Set(all.map((x) => `${x.callSign}|${x.lat}|${x.lon}`)).size, all.length, "each call sign once per spot");
  assert.equal(licensedCell(38.9, -77.03), "38_-78");
  const shared = (await d.get("/map/callsigns")).json.callSigns;
  assert.ok(shared.includes("KNJE616") && shared.some((c: string) => c.startsWith("WPVX")), JSON.stringify(shared));
  // What the map shows, near DC: licensed spots no shared system has.
  const left = all.filter((x) => !shared.includes(x.callSign));
  assert.ok(left.length > 0 && left.length < all.length);
});

test("search: by licensee, call sign and place name; filtered by type", async () => {
  const { d, dcfd, wmata } = await twoSystems();
  const byLicensee = (await d.get("/search?q=metropolitan")).json;
  assert.ok(byLicensee.hits.some((h: any) => h.systemId === wmata), JSON.stringify(byLicensee));
  assert.ok((await d.get("/search?q=WPXT459")).json.hits.some((h: any) => h.systemId === dcfd));
  assert.equal((await d.get("/search?q=metropolitan&types=p25")).json.hits.length, 0);
  const places = (await d.get("/search?q=Arlington")).json.places;
  assert.ok(places.some((p: any) => p.geoid === "51013" && p.kind === "county"), JSON.stringify(places));
});

test("where a system is: its transmitters and the places they're in; an unplaced one says why", async () => {
  const { d, dcfd } = await twoSystems();
  const w = (await d.get(`/systems/${dcfd}/where`)).json;
  assert.equal(w.transmitters.length, 10);
  assert.ok(w.transmitters.every((t: any) => t.countyName === "District of Columbia" && t.placeName === "Washington city" && t.licensee === "DISTRICT OF COLUMBIA"));
  assert.equal(w.placements[0].method, "call_sign");
  const r = await d.share(obs(recorder(), [p25Site(1, 1, 851_000_000, { wacn: 0xbee55 })]));
  const u = (await d.get(`/systems/${r.json.system}/where`)).json;
  assert.equal(u.transmitters.length, 0);
  assert.match(u.placements[0].note, /no license/);
});

test("place search: a name, \"City, ST\", \"City, State\", a ZIP code; each with a point to go to", async () => {
  const { d } = await twoSystems();
  const s = async (q: string) => (await d.get(`/search?q=${encodeURIComponent(q)}`)).json.places;
  const dc = (await s("Washington, DC"))[0];
  assert.equal(dc.geoid, "1150000");
  assert.ok(dc.lat > 38.8 && dc.lon < -76.9);
  assert.equal(dc.county, "11001", "a city with systems knows its county (for its browse link)");
  assert.ok((await s("Arlington, va")).some((p: any) => p.geoid === "51013"));
  assert.ok((await s("Arlington, Virginia")).some((p: any) => p.geoid === "5103000"));
  assert.equal((await s("Arlington, MD")).length, 0, "not in Maryland");
  assert.deepEqual((await s("20001")).map((p: any) => [p.kind, p.name, p.lat > 38.9]), [["zip", "ZIP 20001", true]]);
  assert.equal((await s("99999")).length, 0);
});

test("what a licensed system likely is, by its emissions: digital wins over analog kept beside it", () => {
  assert.equal(licensedKind(["8K10F1E,8K10F1D", "8K10F1D"]), "p25");
  assert.equal(licensedKind(["8K70D1W"]), "p25", "simulcast LSM");
  assert.equal(licensedKind(["9K80D7W"]), "p25", "Phase 2");
  assert.equal(licensedKind(["11K0F3E,7K60FXE", "11K2F3E"]), "dmr", "DMR with analog FM still licensed");
  assert.equal(licensedKind(["4K00F1E"]), "nxdn");
  assert.equal(licensedKind(["20K0F2D", "20K0F3E"]), "analog", "SmartNet-style: a data control channel and FM voice");
  assert.equal(licensedKind(["7K60FXE", "8K10F1E", "8K10F1E"]), "p25", "the mode on the most frequencies");
  assert.equal(licensedKind([null, ""]), "");
  // The type filter: analog under SmartNet or EDACS; unknown only when showing every type.
  assert.ok(licensedShown("p25", ["p25"]) && !licensedShown("dmr", ["p25"]));
  assert.ok(licensedShown("analog", ["smartnet"]) && licensedShown("analog", ["edacs"]) && !licensedShown("analog", ["p25", "dmr"]));
  assert.ok(licensedShown("", ["p25", "smartnet", "dmr", "nxdn", "edacs"]) && !licensedShown("", ["p25"]));
});

test("the licensed layer's spots know their kind: DC Fire and EMS's are P25, WMATA's analog", async () => {
  const all = await licensedSpots(fccSqlite());
  const kinds = (c: string) => [...new Set(all.filter((x) => x.callSign === c).map((x) => x.kind))];
  assert.deepEqual(kinds("WPXT459"), ["p25"]);
  assert.deepEqual(kinds("WPVX365"), ["analog"]);
});

test("an unnamed system's bundle: named by who holds its licenses", async () => {
  const { d, wmata } = await twoSystems();
  const b = (await d.get(`/systems/${wmata}/config`)).json;
  assert.match(b.source.licensee, /Metropolitan Area Transit/i);
  assert.equal(b.system.shortName, "washington-metropolitan");
  assert.equal(b.system.name, undefined);
});
