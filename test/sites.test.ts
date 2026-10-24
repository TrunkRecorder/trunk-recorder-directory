// One site recorded once: a share's sites matched within its system, a
// system merge's sites joined, and a system's twin sites mended (sites.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ObservedSite } from "../src/observation.ts";
import { sameSite } from "../src/sites.ts";
import { directory, obs, p25Site, recorder } from "./helpers.ts";

/** WMATA's site as TRP shares it: SmartNet site 1, its control channels; no name. */
const wmata = (more: Partial<ObservedSite> = {}): ObservedSite => {
  const cc = [490_787_500, 490_862_500, 496_437_500, 496_537_500];
  return { controlChannelsHz: cc, expect: { sysId: 0x8209, site: 1 }, heard: { identity: { sysId: 0x8209, site: 1 }, controlChannelHz: cc[0], voice: [{ freqHz: 490_762_500, grants: 3 }], neighbours: [], callSigns: [], good: 500, bad: 2 }, ...more };
};
const smartnet = (site: ObservedSite, more = {}) => obs(recorder(), [site], { system: { type: "smartnet", name: "", sites: [site] }, ...more });

test("the same site: by its numbers when both have them, else by a control channel in common", () => {
  assert.ok(sameSite({ rfss: 1, site: 3, controlHz: [851e6] }, { rfss: 1, site: 3, controlHz: [852e6] }));
  assert.ok(!sameSite({ rfss: 1, site: 3, controlHz: [851e6] }, { rfss: 1, site: 4, controlHz: [851e6] }), "1-3 and 1-4 share a channel: two sites");
  assert.ok(sameSite({ rfss: null, site: 1, controlHz: [] }, { rfss: null, site: 1, controlHz: [490_787_500] }), "SmartNet site 1");
  assert.ok(sameSite({ rfss: null, site: null, controlHz: [490_787_500, 496_437_500] }, { rfss: null, site: 1, controlHz: [496_437_500] }));
  assert.ok(!sameSite({ rfss: null, site: null, controlHz: [851e6] }, { rfss: null, site: null, controlHz: [852e6] }));
});

test("a share linked to its system, naming none of its sites, finds them in the system (WMATA's two site 1s)", async () => {
  const d = directory();
  // Its first share: no region (no towers known), so its site has no claims.
  const a = await d.share({ ...smartnet(wmata()), cell: null });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  // Again, linked to the system, but the site not linked (as TRP's config was): the same site.
  const b = await d.share({ ...smartnet(wmata(), { directory: { id: a.json.system, rev: a.json.rev } }), cell: null });
  assert.equal(b.json.system, a.json.system);
  assert.deepEqual(b.json.sites, a.json.sites);
  assert.equal((await d.get(`/systems/${a.json.system}`)).json.sites.length, 1);
});

test("two P25 sites with their own numbers stay two, though a control channel is the same", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 3, 851_000_000)]));
  const b = await d.share(obs(recorder(), [p25Site(1, 4, 851_000_000)], { directory: { id: a.json.system, rev: a.json.rev } }));
  assert.equal(b.json.system, a.json.system);
  assert.equal((await d.get(`/systems/${a.json.system}`)).json.sites.length, 2);
});

test("a system merge joins SmartNet sites (no RFSS) that are one site", async () => {
  const d = directory();
  // Far apart (a weak identity, two regions): two systems, each with site 1.
  const a = await d.share({ ...smartnet(wmata()), cell: undefined });
  const b = await d.share({ ...smartnet(wmata({ controlChannelsHz: [496_437_500] })), cell: "862a1072fffffff" });
  assert.notEqual(b.json.system, a.json.system, JSON.stringify(b.json));
  const m = await d.post("/merges", { a: a.json.system, b: b.json.system, why: "test" });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  const s = (await d.get(`/systems/${a.json.system}`)).json;
  assert.equal(s.sites.length, 1, JSON.stringify(s.sites.map((x: any) => x.id)));
});

test("a system's site recorded twice, before sites were matched in their system: placing again mends it", async () => {
  const d = directory({ place: true });
  const a = await d.share(smartnet(wmata()));
  const id = a.json.system;
  const [kept] = a.json.sites;
  // A second record of it, as the old matching made: the same site, its channels, a later first heard.
  const twin = "site_twin0000001";
  d.db.raw.prepare("INSERT INTO sites (id, system_id, name, rfss, site, nac, modulation, status, first_heard, last_heard) SELECT ?, system_id, name, rfss, site, nac, modulation, status, first_heard + 1000, last_heard FROM sites WHERE id = ?").run(twin, kept);
  d.db.raw.prepare("INSERT INTO site_freqs (id, site_id, freq_hz, use, first_heard, last_heard, grants) SELECT 'fq_' || substr(id, 4) || 'x', ?, freq_hz, use, first_heard, last_heard, grants FROM site_freqs WHERE site_id = ?").run(twin, kept);
  assert.equal((await d.get(`/systems/${id}`)).json.sites.length, 2);
  const r = await d.post(`/systems/${id}/place`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.mergedSites, [twin]);
  const s = (await d.get(`/systems/${id}`)).json;
  assert.deepEqual(s.sites.map((x: any) => x.id), [kept]);
  assert.equal(s.sites[0].controlChannelsHz.length, 4);
  // A recorder linked to the twin is sent to the one kept.
  const again = await d.share(smartnet({ ...wmata(), directoryId: twin }, { directory: { id, rev: s.rev } }));
  assert.deepEqual(again.json.sites, [kept]);
});
