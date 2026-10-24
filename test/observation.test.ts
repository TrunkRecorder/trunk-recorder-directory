// Checking a share: what's refused, what's dropped, what's kept.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Invalid, MAX_SITES, parseObservation } from "../src/observation.ts";
import { DC, obs, p25Site, recorder } from "./helpers.ts";

const ok = () => obs(recorder(), [p25Site(1, 1, 851_000_000)]);

test("a well-formed share is kept as sent", () => {
  const o = ok();
  const p = parseObservation(JSON.parse(JSON.stringify(o)));
  assert.equal(p.recorder, o.recorder);
  assert.equal("cell" in p, false, "where the recorder is isn't taken");
  assert.deepEqual(p.system.sites[0].expect, { wacn: 0xbee01, sysId: 0x3a9, rfss: 1, site: 1 });
  assert.equal(p.system.sites[0].heard!.voice!.length, 1);
});

test("a share is refused when its shape is wrong", () => {
  const bad: [string, unknown][] = [
    ["not an object", "x"],
    ["null", null],
    ["no version", { ...ok(), v: undefined }],
    ["another version", { ...ok(), v: 2 }],
    ["no recorder", { ...ok(), recorder: undefined }],
    ["a recorder ID too short", { ...ok(), recorder: "r_abc" }],
    ["a recorder ID with letters not base32", { ...ok(), recorder: "r_iiiiiiiiii" }],
    ["no system", { ...ok(), system: undefined }],
    ["an unknown type", { ...ok(), system: { ...ok().system, type: "tetra" } }],
    ["no sites", { ...ok(), system: { ...ok().system, sites: [] } }],
    ["too many sites", { ...ok(), system: { ...ok().system, sites: Array.from({ length: MAX_SITES + 1 }, () => p25Site(1, 1, 851e6)) } }],
    ["a site with no control channel", { ...ok(), system: { ...ok().system, sites: [{ controlChannelsHz: [] }] } }],
    ["a site that isn't an object", { ...ok(), system: { ...ok().system, sites: [7] } }],
  ];
  for (const [why, o] of bad) assert.throws(() => parseObservation(o), Invalid, why);
});

test("fields of the wrong type are dropped, not trusted", () => {
  const o: any = ok();
  o.app = 42;
  o.directory = { id: "sys_x", rev: "12" };
  o.system.name = "x".repeat(500);
  const s = o.system.sites[0];
  s.controlChannelsHz = [851e6, "852e6", -1, 1e12, NaN];
  s.expect = { wacn: -1, sysId: 0x10000, rfss: 1.5, site: 2, nac: "443" };
  s.heard.voice = [{ freqHz: 852e6, grants: 3 }, { freqHz: "x", grants: 1 }, { freqHz: 853e6, grants: -1 }];
  s.heard.neighbours = [{ rfss: 1, site: 2, freqHz: 852e6 }, { rfss: 300, site: 1, freqHz: 852e6 }];
  s.heard.callSigns = [{ freqHz: 852e6, callSign: "KNJA391" }, { freqHz: 852e6, callSign: "lower1" }, { freqHz: 852e6, callSign: "AB" }];
  s.directoryId = "../etc";
  o.talkgroups = [{ number: 100, alpha: "A".repeat(200), source: "rr" }, { number: 0 }, { number: 2 ** 25 }, { number: 101, priority: 3 }];
  o.heardTalkgroups = [{ number: 100, grants: 2, sites: [0, 5, -1] }, { number: 101 }];
  o.system.fcc = { "857987600": { callSign: "WPXT459", from: "air" }, "x": { callSign: "WPXT459" }, "858000000": { callSign: "bad sign" } };
  const p = parseObservation(o);
  assert.equal(p.app, "");
  assert.equal(p.directory, null);
  assert.equal(p.system.name!.length, 80);
  assert.deepEqual(p.system.sites[0].controlChannelsHz, [851e6]);
  assert.deepEqual(p.system.sites[0].expect, { site: 2 });
  assert.deepEqual(p.system.sites[0].heard!.voice, [{ freqHz: 852e6, grants: 3 }]);
  assert.equal(p.system.sites[0].heard!.neighbours!.length, 1);
  assert.deepEqual(p.system.sites[0].heard!.callSigns!.map((c) => c.callSign), ["KNJA391"]);
  assert.equal(p.system.sites[0].directoryId, undefined);
  assert.deepEqual(p.talkgroups!.map((t) => t.number), [100, 101]);
  assert.equal(p.talkgroups![0].alpha!.length, 64);
  assert.equal(p.talkgroups![0].source, "user", "an unknown source is the user's");
  assert.equal(p.talkgroups![1].priority, undefined);
  assert.deepEqual(p.heardTalkgroups, [{ number: 100, grants: 2, sites: [0], encrypted: false }]);
  assert.deepEqual(p.system.fcc, { "857987500": { callSign: "WPXT459", name: undefined, from: "air" } });
});

test("a location sent with a share isn't kept: it never reaches the record, R2, or the database", () => {
  const p = parseObservation({ ...ok(), cell: "862aa845fffffff", lat: 38.9, lon: -77.03 });
  assert.deepEqual(Object.keys(p).filter((k) => ["cell", "lat", "lon"].includes(k)), []);
});
