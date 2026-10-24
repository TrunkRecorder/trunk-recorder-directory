// A directory on in-memory SQLite, driven through its API as TRP and the website drive it.

import { latLngToCell } from "h3-js";
import { BASE, handle } from "../src/api.ts";
import type { Observation, ObservedSite } from "../src/observation.ts";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { regionOf } from "../src/geo.ts";
import { Places } from "../src/places.ts";
import { ownCallSigns } from "../src/share.ts";
import { fccSqlite, sqlite } from "../src/sqlite.ts";

export const TOKEN = "test-admin-token";

/** Places: two near each other, one far away. */
export const DC = latLngToCell(38.9, -77.03, 6);
export const ARLINGTON = latLngToCell(38.88, -77.1, 6);
export const DENVER = latLngToCell(39.74, -104.99, 6);

/** The Census boundaries for DC, Arlington and Prince George's (test/fixtures/geo). */
export const fixturePlaces = () => new Places((st) => readFile(join(import.meta.dirname, "fixtures", "geo", `${st}.json`), "utf8").catch(() => null));

/** `place`: sites are placed from the FCC fixture's licenses after each share. */
export function directory(opts: { place?: boolean } = {}) {
  const db = sqlite();
  if (opts.place) db.raw.exec(readFileSync(join(import.meta.dirname, "fixtures", "places.sql"), "utf8"));
  const kept: Record<string, string> = {};
  let clock = Date.UTC(2026, 9, 21);
  // Where the next share is from: its towers' region. With the FCC fixture (place), its real towers;
  // without, the test says (as `cell` on its observation, never sent: the region its towers would be in).
  let region: string | null = regionOf(DC);
  const env = {
    db, adminToken: TOKEN, putObservation: async (k: string, b: string) => void (kept[k] = b), now: () => (clock += 1000),
    ...(opts.place ? { fcc: fccSqlite(), places: fixturePlaces() } : { towersOf: async (o: Observation) => ({ region, callSigns: ownCallSigns(o).callSigns }) }),
  };
  const call = async (method: string, path: string, body?: unknown, admin = false) => {
    const res = await handle(env, new Request(`http://x${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(admin ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    }));
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };
  return {
    db,
    kept,
    get: (p: string) => call("GET", p),
    post: (p: string, b?: unknown, admin = true) => call("POST", p, b, admin),
    del: (p: string, admin = true) => call("DELETE", p, undefined, admin),
    share: (o: TestObservation) => {
      const { cell, ...rest } = o;
      region = cell === null ? null : regionOf(cell ?? DC);
      return call("POST", "/observations", rest, false);
    },
  };
}

/** A P25 site as TRP shares it. */
export function p25Site(rfss: number, site: number, cc: number, more: Partial<ObservedSite> & { wacn?: number; sysId?: number; neighbours?: [number, number, number][] } = {}): ObservedSite {
  const { wacn = 0xbee01, sysId = 0x3a9, neighbours = [], ...rest } = more;
  return {
    controlChannelsHz: [cc],
    expect: { wacn, sysId, rfss, site },
    heard: {
      identity: { nac: 0x443, wacn, sysId, rfss, site },
      controlChannelHz: cc,
      voice: [{ freqHz: cc + 1_000_000, grants: 12 }],
      neighbours: neighbours.map(([r, s, f]) => ({ sysId, rfss: r, site: s, freqHz: f })),
      callSigns: [],
      good: 1000,
      bad: 10,
    },
    ...rest,
  };
}

let n = 0;
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
/** A new recorder ID, as TRP makes them. */
export const recorder = () => {
  let x = ++n;
  let s = "";
  for (let i = 0; i < 10; i++, x = Math.floor(x / 32)) s = CROCKFORD[x % 32] + s;
  return `r_${s}`;
};

/** An observation for a test, with where its towers are (`cell`: the region they'd be in; null: none found). Never sent. */
export type TestObservation = Observation & { cell?: string | null };

export function obs(rec: string, sites: ObservedSite[], more: Partial<TestObservation> = {}): TestObservation {
  return { v: 1, recorder: rec, app: "test", system: { type: "p25", name: "DC Fire and EMS", sites }, talkgroups: [], heardTalkgroups: [], ...more };
}
