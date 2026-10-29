// Statewide systems: a state's State License lists no sites (ArgusRF's
// unsited_license), so the map can't place it; the map's panel lists it for the
// state you're in or looking at, as the shared system that sends its call sign,
// or as the license. On real licenses: DC's (WPTZ766), Virginia's (WPTZ775)
// and Missouri's (WPTZ785, MOSWIN's).

import assert from "node:assert/strict";
import { test } from "node:test";
import { handleFcc, type CallSignsResponse } from "../src/fcc/api.ts";
import { fccSqlite } from "../src/sqlite.ts";
import { directory, obs, p25Site, recorder } from "./helpers.ts";

/** DC Fire and EMS's site, sending DC's State License's call sign besides its own (as MOSWIN's sites send Missouri's). */
const dcfd = () =>
  p25Site(1, 3, 857_987_500, {
    wacn: 0xbee00, sysId: 0x445, controlChannelsHz: [855_462_500, 857_987_500],
    heard: {
      identity: { nac: 0x443, wacn: 0xbee00, sysId: 0x445, rfss: 1, site: 3 }, controlChannelHz: 857_987_500, voice: [{ freqHz: 769_906_250, grants: 4 }], neighbours: [],
      callSigns: [{ freqHz: 859_987_500, callSign: "KNJE616" }, { freqHz: 769_906_250, callSign: "WPTZ766" }], good: 900, bad: 3,
    },
  });

test("who holds a call sign with no site listed: the state, from its license's address", async () => {
  const r = await handleFcc(fccSqlite(), new Request("http://x/api/v1/fcc/callsigns", { method: "POST", body: JSON.stringify({ callSigns: ["WPTZ785", "KNJE616"] }) }));
  const body = (await r!.json()) as CallSignsResponse;
  const mo = body.results.find((x) => x.callSign === "WPTZ785");
  assert.deepEqual(mo, { callSign: "WPTZ785", licensee: "Missouri, State of", serviceCode: "SL", serviceDesc: "Public Safety 700 MHZ Band-State License", status: "A", city: "Jefferson City", state: "MO" });
  assert.equal(body.results.find((x) => x.callSign === "KNJE616")?.licensee, "DISTRICT OF COLUMBIA");
});

test("a state's statewide systems: the shared one with its license, and a license no one has shared", async () => {
  const d = directory({ place: true });
  const sys = (await d.share(obs(recorder(), [dcfd()]))).json.system as string;
  const dc = (await d.get("/statewide?state=DC")).json;
  assert.equal(dc.name, "District of Columbia");
  assert.deepEqual(dc.systems.map((s: any) => [s.id, s.shared, s.type, s.callSigns]), [[sys, true, "p25", ["WPTZ766"]]]);
  const va = (await d.get("/statewide?state=VA")).json;
  assert.deepEqual(va.systems.map((s: any) => [s.id, s.shared, s.licensee]), [["fcc_wptz775", false, "Virginia, Commonwealth of"]]);
  // What a license is isn't licensed: shown only with every type.
  assert.deepEqual((await d.get("/statewide?state=VA&types=p25")).json.systems, []);
  assert.equal((await d.get("/statewide?state=DC&types=smartnet")).json.systems.length, 0);
  assert.deepEqual((await d.get("/statewide?state=ZZ")).json.systems, []);
});

test("the state at a point: the map's centre, or your location", async () => {
  const d = directory({ place: true });
  assert.equal((await d.get("/statewide?lat=38.9&lon=-77.03")).json.state, "DC");
  assert.equal((await d.get("/statewide?lat=38.88&lon=-77.1")).json.state, "VA", "Arlington");
  assert.equal((await d.get("/statewide?lat=36.5&lon=-71")).json.state, null, "at sea");
  assert.equal((await d.get("/statewide")).status, 400);
});

test("a license no one has shared, with no sites: its page is who holds it", async () => {
  const d = directory({ place: true });
  const s = (await d.get("/systems/fcc_wptz775")).json;
  assert.equal(s.status, "licensed");
  assert.equal(s.licensee, "Virginia, Commonwealth of");
  assert.deepEqual(s.sites, []);
  assert.deepEqual((await d.get("/systems/fcc_wptz775/where")).json.transmitters, []);
});

test("an FCC database built before ArgusRF kept unsited licenses: none, not an error", async () => {
  const fcc = fccSqlite();
  fcc.raw.exec("DROP TABLE unsited_license");
  const r = await handleFcc(fcc, new Request("http://x/api/v1/fcc/callsigns", { method: "POST", body: JSON.stringify({ callSigns: ["WPTZ785"] }) }));
  assert.equal(r!.status, 200);
  assert.deepEqual(((await r!.json()) as CallSignsResponse).results, []);
});
