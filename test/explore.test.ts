// Exploring: by place (state → county → city), the map's layers, near a
// point, and licensed systems no one has shared — on real DC licenses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { latLngToCell } from "h3-js";
import { parseTypes } from "../src/explore.ts";
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

test("licensed, not shared: trunked base stations in a box, without the call signs the directory has", async () => {
  const { d } = await twoSystems();
  const r = (await d.get("/map/licensed?bbox=-77.15,38.8,-76.9,39.0")).json.licensed;
  assert.ok(r.length > 0);
  assert.ok(!r.some((x: any) => ["KNJE616", "WPXT459", "WPVX365"].includes(x.callSign)), "shared ones left out");
  assert.ok(r.every((x: any) => x.stationClass.startsWith("FB")));
  assert.ok(r.every((x: any) => /Trunked/.test(x.serviceDesc) || x.stationClass.startsWith("FB8")), JSON.stringify(r.slice(0, 3)));
  assert.equal((await d.get("/map/licensed?bbox=-80,35,-70,45")).json.tooBig, true);
  assert.equal((await d.get("/map/licensed?bbox=nope")).status, 400);
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
