// Sample shares into a local directory (npm run dev:api first), through the
// API as Trunk Recorder Pro sends them: a two-site P25 system heard by two
// recorders that disagree on a name, and one far away.
//
//   node scripts/seed.ts [http://localhost:8790]

import { latLngToCell } from "h3-js";

const BASE = `${process.argv[2] ?? "http://localhost:8790"}/directory/api/v1`;
const DC = latLngToCell(38.9, -77.03, 6);
const ARL = latLngToCell(38.88, -77.1, 6);
const DEN = latLngToCell(39.74, -104.99, 6);

const site = (rfss: number, s: number, cc: number, wacn: number, sysId: number, neighbours: [number, number, number][] = [], callSigns: [number, string][] = []) => ({
  name: "",
  controlChannelsHz: [cc],
  expect: { wacn, sysId, rfss, site: s },
  modulation: "qpsk",
  heard: {
    identity: { nac: 0x443, wacn, sysId, rfss, site: s },
    controlChannelHz: cc,
    voice: [0, 1, 2, 3].map((i) => ({ freqHz: cc + 250_000 + i * 500_000, grants: 20 + i * 7 })),
    neighbours: neighbours.map(([r, x, f]) => ({ sysId, rfss: r, site: x, freqHz: f })),
    callSigns: callSigns.map(([f, c]) => ({ freqHz: f, callSign: c })),
    good: 12000,
    bad: 140,
  },
});

const tgs = (names: Record<number, [string, string, string]>) => Object.entries(names).map(([n, [alpha, tag, category]]) => ({ number: Number(n), alpha, description: "", mode: "D", tag, category }));

async function share(body: unknown) {
  const r = await fetch(`${BASE}/observations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  console.log(r.status, JSON.stringify(j));
  return j;
}

const county = { 716: ["FD Disp", "Fire Dispatch", "Fire"], 717: ["FD Tac 1", "Fire-Tac", "Fire"], 718: ["FD Tac 2", "Fire-Tac", "Fire"], 800: ["EMS Disp", "EMS Dispatch", "EMS"], 901: ["PD 1D Disp", "Law Dispatch", "Police"], 902: ["PD 2D Disp", "Law Dispatch", "Police"], 1501: ["DPW Ops", "Public Works", "Services"] } as Record<number, [string, string, string]>;

const a = await share({
  v: 1, recorder: "r_seed00000a", app: "seed", cell: DC,
  system: { type: "p25", name: "Capital Area Public Safety", fcc: { "857987500": { callSign: "WPXT459", name: "DISTRICT OF COLUMBIA", from: "lookup" } },
    sites: [site(1, 1, 857_987_500, 0xbee01, 0x1f2, [[1, 2, 858_987_500], [1, 3, 860_437_500]], [[859_087_500, "KNJA391"], [859_987_500, "KNJE616"]])] },
  talkgroups: tgs(county),
  heardTalkgroups: Object.keys(county).map((n, i) => ({ number: Number(n), grants: 40 - i * 4, sites: [0] })).concat([{ number: 4242, grants: 3, sites: [0] }]),
});
await share({
  v: 1, recorder: "r_seed00000b", app: "seed", cell: ARL,
  system: { type: "p25", name: "Capital Area Public Safety", sites: [site(1, 2, 858_987_500, 0xbee01, 0x1f2, [[1, 1, 857_987_500]])] },
  talkgroups: tgs({ ...county, 716: ["Fire Dispatch", "Fire Dispatch", "Fire"], 1601: ["Schools Ops", "Schools", "Services"] }),
  heardTalkgroups: [{ number: 716, grants: 50, sites: [0] }, { number: 1601, grants: 9, sites: [0] }],
});
await share({
  v: 1, recorder: "r_seed00000c", app: "seed", cell: DEN,
  system: { type: "p25", name: "Front Range Regional", sites: [site(1, 1, 851_012_500, 0xbee02, 0x2a1)] },
  talkgroups: tgs({ 100: ["Dispatch North", "Law Dispatch", "Sheriff"], 101: ["Dispatch South", "Law Dispatch", "Sheriff"] }),
  heardTalkgroups: [{ number: 100, grants: 12, sites: [0] }],
});
console.log(`\nOpen http://localhost:8790/directory/systems/${a.system}`);
