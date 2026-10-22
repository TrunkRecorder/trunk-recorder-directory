// Placing sites from FCC licenses: real DC Fire and EMS and WMATA licenses
// (test/fixtures/fcc.sql), and the Census boundaries around Washington.

import assert from "node:assert/strict";
import { test } from "node:test";
import { choose } from "../src/place.ts";
import { directory, fixturePlaces, obs, p25Site, recorder } from "./helpers.ts";

/** DC Fire and EMS's site 1.3, as TRP shares it: its control channels, a voice channel, a call sign heard on the air. */
const dcfd = () =>
  p25Site(1, 3, 857_987_500, {
    wacn: 0xbee00, sysId: 0x445,
    controlChannelsHz: [855_462_500, 857_987_500],
    heard: {
      identity: { nac: 0x443, wacn: 0xbee00, sysId: 0x445, rfss: 1, site: 3 },
      controlChannelHz: 857_987_500,
      voice: [{ freqHz: 769_906_250, grants: 4 }],
      neighbours: [],
      callSigns: [{ freqHz: 859_987_500, callSign: "KNJE616" }],
      good: 900,
      bad: 3,
    },
  });

test("a P25 site is placed at its licensed transmitters, by the call sign heard on the air", async () => {
  const d = directory({ place: true });
  const r = await d.share(obs(recorder(), [dcfd()]));
  assert.equal(r.status, 201);
  const s = (await d.get(`/systems/${r.json.system}`)).json;
  const site = s.sites[0];
  assert.ok(Math.abs(site.lat - 38.91) < 0.05 && Math.abs(site.lon - -77.02) < 0.06, `${site.lat}, ${site.lon}`);
  const tx = await d.db.all<any>("SELECT * FROM site_transmitters WHERE site_id = ? ORDER BY lat", [site.id]);
  // Simulcast: its control channels are licensed at ten towers, under three call signs.
  assert.equal(tx.length, 10);
  assert.ok(tx.every((t) => t.state === "DC" && t.county === "11001" && t.place === "1150000"), JSON.stringify(tx.map((t) => [t.state, t.county, t.place])));
  assert.ok(tx.every((t) => t.licensee === "DISTRICT OF COLUMBIA" && t.station_class.startsWith("FB") && t.height_m > 0 && t.erp_w > 0));
  assert.ok(tx.some((t) => t.call_sign === "KNJE616"), "the call sign it heard names its towers");
  const p = (await d.db.all<any>("SELECT * FROM placements WHERE site_id = ?", [site.id]))[0];
  assert.equal(p.method, "call_sign");
  // The licenses it found are the system's (looked up), with their licensee.
  assert.equal(s.licenses["855462500"].name, "DISTRICT OF COLUMBIA");
  assert.equal(s.licenses["855462500"].source, "lookup");
  // The system is where its sites are, and its history says so.
  assert.ok(Math.abs(s.lat - 38.91) < 0.05);
  const h = (await d.get(`/systems/${s.id}/history`)).json.history;
  assert.ok(h.some((e: any) => e.note === "placed from FCC licenses"));
});

test("a SmartNet site with no call sign is placed by its frequencies (WMATA)", async () => {
  const d = directory({ place: true });
  const cc = [496_437_500, 490_862_500, 496_537_500, 490_787_500];
  const site = { controlChannelsHz: cc, heard: { controlChannelHz: cc[0], voice: [489_087_500, 489_512_500, 496_612_500].map((freqHz) => ({ freqHz, grants: 3 })), neighbours: [], callSigns: [], good: 500, bad: 2 } };
  const r = await d.share(obs(recorder(), [site], { system: { type: "smartnet", sites: [site] } }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const tx = await d.db.all<any>("SELECT * FROM site_transmitters");
  assert.ok(tx.length >= 1, "placed");
  assert.ok(tx.every((t) => /Metropolitan Area Transit/i.test(t.licensee)), JSON.stringify(tx.map((t) => t.licensee)));
  assert.equal((await d.db.all<any>("SELECT method FROM placements"))[0].method, "fingerprint");
});

test("a site on no licensed frequency isn't placed, and says why; placing again waits for a change", async () => {
  const d = directory({ place: true });
  const r = await d.share(obs(recorder(), [p25Site(1, 1, 851_000_000)]));
  const p = await d.db.all<any>("SELECT * FROM placements");
  assert.equal(p[0].method, "none");
  assert.match(p[0].note, /no license/);
  const s = (await d.get(`/systems/${r.json.system}`)).json;
  assert.equal(s.sites[0].lat, null);
  // The same share again: not placed again (nothing changed).
  await d.share(obs(recorder(), [p25Site(1, 1, 851_000_000)], { directory: { id: s.id, rev: s.rev } }));
  assert.equal((await d.db.all<any>("SELECT at FROM placements"))[0].at, p[0].at);
  // An admin can.
  const again = await d.post(`/systems/${s.id}/place`, {});
  assert.equal(again.status, 200);
  assert.equal(again.json.unplaced.length, 1);
});

test("two equally good spots far apart are ambiguous, not a guess", () => {
  const row = (call: string, lat: number, lon: number, f: number) => ({ call_sign: call, licensee_name: call, freq_center_hz: f, lat, lon, structure_height_m: 30, power_erp_w: 100, class_station_code: "FB2", location_state: "VA" });
  const rows = [row("WAAA111", 38.9, -77.0, 851_012_500), row("WAAA111", 38.9, -77.0, 852_012_500), row("WBBB222", 37.5, -77.4, 851_012_500), row("WBBB222", 37.5, -77.4, 852_012_500)];
  const r = choose(rows, [851_012_500], [851_012_500, 852_012_500], new Set());
  assert.equal(r.transmitters.length, 0);
  assert.match(r.note, /ambiguous/);
  // A call sign the system has settles it.
  assert.equal(choose(rows, [851_012_500], [851_012_500, 852_012_500], new Set(["WBBB222"])).transmitters[0].callSign, "WBBB222");
});

test("the Census boundaries: DC, Arlington, and outside any city", async () => {
  const p = fixturePlaces();
  assert.deepEqual(await p.at("DC", 38.8977, -77.0365), { state: "DC", county: "11001", place: "1150000" });
  assert.deepEqual(await p.at("VA", 38.8816, -77.0910), { state: "VA", county: "51013", place: "5103000" });
  assert.deepEqual(await p.at("MD", 38.7, -76.75), { state: "MD", county: "24033", place: "" });
  assert.deepEqual(await p.at("ZZ", 38.7, -76.75), { state: "ZZ", county: "", place: "" });
});
