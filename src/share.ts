// A share from Trunk Recorder Pro, into the directory. docs/design.md,
// "Sharing from Trunk Recorder Pro" and "Partial views".
//
// Site first: each site is found by the directory ID the recorder has for it,
// else by its claims (identity, control channels in the region); its system
// is the one its sites are in, else the one its identity names, else a new
// one. What the air says is applied (it only adds and refreshes); what a person
// wrote is an assertion ([names.ts]) and only what they changed from the
// version they imported counts. One share is one change set.

import { type ClaimKeys, callSignClaim, neighbourClaim, siteClaims, systemClaim } from "./claims.ts";
import { type Db, type Row, insertRows, marks } from "./db.ts";
import { NameIndex } from "./names.ts";
import type { Observation, ObservedSite, SiteIdentity } from "./observation.ts";
import { ChangeSet } from "./store.ts";

const raster = (hz: number) => Math.round(hz / 6250) * 6250;
const TG_FIELDS = ["alpha", "description", "mode", "tag", "category", "priority"] as const;

export interface ShareResult {
  systemId: string;
  rev: number;
  created: boolean;
  /** The directory's ID for each site, in the share's order: TRP keeps them. */
  sites: string[];
  /** Systems found to be this one, and merged into it. */
  merged: string[];
  changesetId: string | null;
}

/** Follow redirects (a merged record's ID) to the record now. */
export async function resolve(db: Db, id: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const r = (await db.all<{ new_id: string }>("SELECT new_id FROM redirects WHERE id = ?", [id]))[0];
    if (!r) return id;
    id = r.new_id;
  }
  return id;
}

/** The records claims point at, best first (strong claims, then most observed). */
async function lookupClaims(cs: ChangeSet, claims: ClaimKeys[], kind: string): Promise<{ id: string; strong: boolean }[]> {
  const keys = claims.flatMap((c) => c.lookup);
  if (!keys.length) return [];
  const strongKeys = new Set(claims.filter((c) => c.strong).flatMap((c) => c.lookup));
  const rows = await cs.query("claim", `key IN (${marks(keys.length)}) AND record_kind = ?`, [...keys, kind], (r) => keys.includes(r.key as string) && r.record_kind === kind);
  const by = new Map<string, { id: string; strong: boolean; n: number }>();
  for (const r of rows) {
    const id = await resolve(cs.db, r.record_id as string);
    const e = by.get(id) ?? { id, strong: false, n: 0 };
    e.strong ||= strongKeys.has(r.key as string);
    e.n += (r.observations as number) ?? 0;
    by.set(id, e);
  }
  return [...by.values()].sort((a, b) => Number(b.strong) - Number(a.strong) || b.n - a.n);
}

/** Make sure `record` has these claims, and count this observation on them. */
export async function claim(cs: ChangeSet, claims: ClaimKeys[], kind: string, recordId: string): Promise<void> {
  for (const key of claims.flatMap((c) => c.store)) {
    const have = await cs.query("claim", "key = ? AND record_id = ?", [key, recordId], (r) => r.key === key && r.record_id === recordId);
    const c = have[0] ?? (await cs.create("claim", { key, record_kind: kind, record_id: recordId, observations: 0, first_seen: cs.at }));
    await cs.stat("claim", c.id as string, { last_seen: cs.at }, { observations: 1 });
  }
}

const identityOf = (s: ObservedSite): SiteIdentity => ({ ...(s.expect ?? {}), ...Object.fromEntries(Object.entries(s.heard?.identity ?? {}).filter(([, v]) => v != null)) });

/**
 * A site found only by a weak claim (its control channel, nearby) is taken
 * only if nothing says it's another: its system shown (not hidden, retired or
 * merged away), and no identity that disagrees (WACN, System ID; RFSS and site).
 */
async function weakMatchHolds(cs: ChangeSet, siteId: string, id: SiteIdentity): Promise<boolean> {
  const site = await cs.get("site", siteId);
  if (!site || site.status === "merged" || site.status === "retired") return false;
  const sys = await cs.get("system", await resolve(cs.db, site.system_id as string));
  if (!sys || sys.status !== "active") return false;
  if (!sameIdentity(sys, [id])) return false;
  if (differs(site.rfss, id.rfss) || differs(site.site, id.site)) return false;
  return true;
}

const differs = (a: unknown, b: unknown) => a != null && b != null && a !== b;

/** Nothing the air says (WACN, System ID) has this system another one: a call sign, or towers, can say it's the same. */
const sameIdentity = (sys: Record<string, unknown>, ids: SiteIdentity[]) => ids.every((id) => !differs(sys.wacn, id.wacn) && !differs(sys.sys_id, id.sysId));

/** The systems a share's call signs name: strong, unless the air says they're another (a license can hold two systems). */
async function byCallSign(cs: ChangeSet, type: string, callSigns: string[], ids: SiteIdentity[]): Promise<string[]> {
  const claims = callSigns.map((c) => callSignClaim(type, c)).filter((c): c is ClaimKeys => !!c);
  const out: string[] = [];
  for (const h of claims.length ? await lookupClaims(cs, claims, "system") : []) {
    const sys = await cs.get("system", h.id);
    if (sys && sys.status === "active" && sameIdentity(sys, ids)) out.push(h.id);
  }
  return out;
}

/** Which system a share is of: by its directory link, its sites' claims, then its identity; and others found to be it. */
async function findSystem(cs: ChangeSet, obs: Observation, region: string | null, ids: SiteIdentity[], callSigns: string[]) {
  // ── which system ──
  const mergeWith = new Map<string, { why: string; decisive: boolean }>();
  const evidence = (id: string, why: string, decisive: boolean) => {
    const had = mergeWith.get(id);
    if (!had || (decisive && !had.decisive)) mergeWith.set(id, { why, decisive });
  };
  const db = cs.db;
  const type = obs.system.type;
  let systemId: string | null = null;
  if (obs.directory?.id) {
    const id = await resolve(db, obs.directory.id);
    const s = await cs.get("system", id);
    if (s && s.status !== "hidden" && s.type === type) systemId = id;
  }
  const siteMatch: (string | null)[] = [];
  const siteStrong: boolean[] = [];
  for (const [i, s] of obs.system.sites.entries()) {
    let found: string | null = null;
    let strong = false;
    if (s.directoryId) {
      const id = await resolve(db, s.directoryId);
      if (await cs.get("site", id)) [found, strong] = [id, true];
    }
    if (!found) {
      for (const hit of await lookupClaims(cs, siteClaims(type, ids[i], s.controlChannelsHz, region), "site")) {
        if (hit.strong || (await weakMatchHolds(cs, hit.id, ids[i]))) {
          [found, strong] = [hit.id, hit.strong];
          break;
        }
      }
    }
    siteMatch.push(found);
    siteStrong.push(strong);
  }
  const sitesSystems: { id: string; strong: boolean }[] = [];
  for (const [i, id] of siteMatch.entries()) {
    const sys = id ? ((await cs.get("site", id))?.system_id as string) : null;
    if (sys) sitesSystems.push({ id: await resolve(db, sys), strong: siteStrong[i] });
  }
  if (!systemId && sitesSystems.length) {
    const count = new Map<string, number>();
    for (const s of sitesSystems) count.set(s.id, (count.get(s.id) ?? 0) + (s.strong ? 10 : 1));
    systemId = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  const idClaims = ids.map((id) => systemClaim(type, id, region)).filter((c): c is ClaimKeys => !!c);
  if (!systemId && idClaims.length) systemId = (await lookupClaims(cs, idClaims, "system"))[0]?.id ?? null;
  const licensed = await byCallSign(cs, type, callSigns, ids);
  if (!systemId) systemId = licensed[0] ?? null;
  const sysClaims = [...idClaims, ...callSigns.map((c) => callSignClaim(type, c)).filter((c): c is ClaimKeys => !!c)];
  // Another system its sites (or identity, strongly) say it is: the same system, found twice.
  for (const s of sitesSystems) {
    if (systemId && s.id !== systemId) evidence(s.id, s.strong ? "a site of it, by its identity, is a site of this one" : "a site of it shares a control channel with this one, nearby", s.strong);
  }
  for (const h of idClaims.length ? await lookupClaims(cs, idClaims, "system") : []) {
    if (systemId && h.strong && h.id !== systemId) evidence(h.id, "the same system identity", true);
  }
  for (const id of licensed) if (systemId && id !== systemId) evidence(id, "the same FCC call sign, and nothing on the air says otherwise", true);

  return { systemId, siteMatch, sysClaims, mergeWith };
}

/**
 * What a share would be matched to, and the other systems it says are the
 * same one (decisive evidence: merged before it's applied, so it lands on one
 * system). Reads only.
 */
/** Where a share is from, by its towers (place.ts shareTowers): the region its weak identities are matched in, and its call signs. */
export interface ShareFrom {
  region: string | null;
  callSigns: string[];
}

/** A share's own call signs (its licenses, those heard on the air), when its towers aren't known (no FCC database). */
export const ownCallSigns = (obs: Observation): ShareFrom => ({
  region: null,
  callSigns: [...Object.values(obs.system.fcc ?? {}).map((l) => l.callSign), ...obs.system.sites.flatMap((x) => (x.heard?.callSigns ?? []).map((c) => c.callSign))],
});

export async function matchShare(db: Db, obs: Observation, from: ShareFrom = ownCallSigns(obs)): Promise<{ systemId: string | null; mergeWith: { id: string; why: string; decisive: boolean }[] }> {
  const cs = new ChangeSet(db, { actorKind: "recorder", actorId: obs.recorder, kind: "share" });
  const region = from.region;
  const ids = obs.system.sites.map(identityOf);
  const m = await findSystem(cs, obs, region, ids, from.callSigns);
  if (m.systemId) {
    // Neighbours announced with the same identity that are another system's sites.
    for (const [i, s] of obs.system.sites.entries()) {
      for (const n of s.heard?.neighbours ?? []) {
        if ((n.sysId ?? ids[i].sysId) !== ids[i].sysId) continue;
        const nc = neighbourClaim(obs.system.type, ids[i], n, region);
        const hit = nc && (await lookupClaims(cs, [nc], "site"))[0];
        const site = hit ? await cs.get("site", hit.id) : null;
        const other = site ? await resolve(db, site.system_id as string) : null;
        if (other && other !== m.systemId) m.mergeWith.set(other, { why: `its site ${n.rfss}-${n.site} is announced as a neighbour by site ${ids[i].rfss}-${ids[i].site} of this one`, decisive: true });
      }
    }
  }
  return { systemId: m.systemId, mergeWith: [...m.mergeWith].map(([id, e]) => ({ id, ...e })) };
}

/**
 * Apply a share. Returns what it was matched to (and made). `decisive`
 * evidence that another system is this one is returned for merging after
 * (merge.ts), as its own change set.
 */
export async function applyShare(db: Db, obs: Observation, observationId: string, now = Date.now(), from: ShareFrom = ownCallSigns(obs)): Promise<ShareResult & { mergeWith: { id: string; why: string; decisive: boolean }[] }> {
  const cs = new ChangeSet(db, { actorKind: "recorder", actorId: obs.recorder, kind: "share", observationId }, now);
  const region = from.region;
  const type = obs.system.type;
  const ids = obs.system.sites.map(identityOf);
  /** Other systems found to be this one: decisive evidence merges them; the rest is proposed. */
  const mergeWith = new Map<string, { why: string; decisive: boolean }>();
  const evidence = (id: string, why: string, decisive: boolean) => {
    const had = mergeWith.get(id);
    if (!had || (decisive && !had.decisive)) mergeWith.set(id, { why, decisive });
  };

  const m = await findSystem(cs, obs, region, ids, from.callSigns);
  let systemId = m.systemId;
  const { siteMatch, sysClaims } = m;
  for (const [k, v] of m.mergeWith) evidence(k, v.why, v.decisive);

  let created = false;
  if (!systemId) {
    const id0 = ids.find((i) => i.sysId != null) ?? {};
    // (Where it is comes from its towers, when it's placed: never from a recorder.)
    const sys = await cs.create("system", {
      type, name: "", wacn: id0.wacn ?? null, sys_id: id0.sysId ?? null, status: "active", merged_into: null,
      lat: null, lon: null, created_at: now, updated_at: now, rev: 0,
    });
    systemId = sys.id as string;
    created = true;
  }
  const system = (await cs.get("system", systemId))!;
  for (const id of ids) {
    if (system.wacn == null && id.wacn != null) await cs.set("system", systemId, "wacn", id.wacn);
    if (system.sys_id == null && id.sysId != null) await cs.set("system", systemId, "sys_id", id.sysId);
  }
  await claim(cs, sysClaims, "system", systemId);

  // ── its sites ──
  const sys = systemId;
  const sitesNow = await cs.query("site", "system_id = ?", [sys], (r) => r.system_id === sys);
  const siteIds: string[] = [];
  for (const [i, s] of obs.system.sites.entries()) {
    const id = ids[i];
    let site = siteMatch[i] ? await cs.get("site", siteMatch[i]!) : null;
    if (site && site.system_id !== sys) site = null; // another system's: merged below, if decisive
    // An announced site (a neighbour's) heard now.
    site ??= sitesNow.find((x) => id.rfss != null && x.rfss === id.rfss && x.site === id.site) ?? null;
    if (!site) {
      site = await cs.create("site", {
        system_id: sys, name: s.name ?? "", rfss: id.rfss ?? null, site: id.site ?? null, nac: id.nac ?? null,
        modulation: s.modulation ?? "", bandplan: s.bandplan ? JSON.stringify(s.bandplan) : "", lat: null, lon: null, loc_source: "",
        status: "heard", merged_into: null, first_heard: now, last_heard: now,
      });
    }
    const siteId = site.id as string;
    siteIds.push(siteId);
    if (site.status === "announced") await cs.set("site", siteId, "status", "heard");
    for (const f of ["rfss", "site", "nac"] as const) if (site[f] == null && id[f] != null) await cs.set("site", siteId, f, id[f]);
    if (s.modulation && !site.modulation) await cs.set("site", siteId, "modulation", s.modulation);
    if (s.bandplan && !site.bandplan) await cs.set("site", siteId, "bandplan", JSON.stringify(s.bandplan));
    await cs.stat("site", siteId, { last_heard: now, first_heard: site.first_heard ?? now });
    await claim(cs, siteClaims(type, id, s.controlChannelsHz, region), "site", siteId);

    // Frequencies: control channels, and voice channels granted (or in the config).
    const freqs = await cs.query("freq", "site_id = ?", [siteId], (r) => r.site_id === siteId);
    const use = async (hz: number, kind: "control" | "voice", grants = 0) => {
      const f = raster(hz);
      let row = freqs.find((x) => x.freq_hz === f && x.use === kind);
      if (!row) {
        row = await cs.create("freq", { site_id: siteId, freq_hz: f, use: kind, first_heard: now, last_heard: now, grants: 0 });
        freqs.push(row);
      }
      await cs.stat("freq", row.id as string, { last_heard: now }, { grants });
    };
    for (const f of s.controlChannelsHz) await use(f, "control");
    const voice = new Map<number, number>();
    for (const f of s.voiceChannelsHz ?? []) voice.set(raster(f), 0);
    for (const v of s.heard?.voice ?? []) voice.set(raster(v.freqHz), (voice.get(raster(v.freqHz)) ?? 0) + v.grants);
    for (const [f, g] of voice) await use(f, "voice", g);

    // Neighbours it announces: linked, as announced sites if no one has shared them.
    for (const n of s.heard?.neighbours ?? []) {
      const nc = neighbourClaim(type, id, n, region);
      let nb: Row | null = null;
      if (nc) {
        const hit = (await lookupClaims(cs, [nc], "site"))[0];
        if (hit) {
          nb = await cs.get("site", hit.id);
          const nbSys = nb ? await resolve(db, nb.system_id as string) : null;
          if (nbSys && nbSys !== sys) {
            // Announced as a neighbour with the same identity: the same system (or the same network).
            if ((n.sysId ?? id.sysId) === id.sysId) evidence(nbSys, `its site ${n.rfss}-${n.site} is announced as a neighbour by site ${id.rfss}-${id.site} of this one`, true);
            nb = null;
          }
        }
      }
      // (A neighbour of another SysID is another system of a network: not made here.)
      if (!nb && (n.sysId == null || n.sysId === id.sysId)) {
        nb = sitesNow.find((x) => x.rfss === n.rfss && x.site === n.site) ?? null;
        if (!nb) {
          nb = await cs.create("site", {
            system_id: sys, name: "", rfss: n.rfss, site: n.site, nac: null, modulation: "", bandplan: "", lat: null, lon: null, loc_source: "",
            status: "announced", merged_into: null, first_heard: null, last_heard: null,
          });
          sitesNow.push(nb);
          await cs.create("freq", { site_id: nb.id, freq_hz: raster(n.freqHz), use: "control", first_heard: now, last_heard: now, grants: 0 });
          if (nc) await claim(cs, [nc], "site", nb.id as string);
        }
      }
      if (nb && nb.id !== siteId) {
        const nbId = nb.id as string;
        const links = await cs.query("neighbour", "site_id = ? AND neighbour_id = ?", [siteId, nbId], (r) => r.site_id === siteId && r.neighbour_id === nbId);
        const link = links[0] ?? (await cs.create("neighbour", { site_id: siteId, neighbour_id: nbId, first_heard: now, last_heard: now }));
        await cs.stat("neighbour", link.id as string, { last_heard: now });
      }
    }
  }

  // ── its licenses: heard on the air, and the config's ──
  const lic = await cs.query("license", "system_id = ?", [sys], (r) => r.system_id === sys);
  const license = async (hz: number, callSign: string, name: string, source: "air" | "user" | "lookup") => {
    const f = raster(hz);
    const have = lic.find((x) => x.freq_hz === f);
    if (!have) {
      lic.push(await cs.create("license", { system_id: sys, freq_hz: f, call_sign: callSign, name, source }));
      return;
    }
    const id = have.id as string;
    if (source === "air" && have.source !== "user") {
      if (have.call_sign !== callSign) {
        await cs.set("license", id, "call_sign", callSign);
        await cs.set("license", id, "name", "");
      }
      await cs.set("license", id, "source", "air");
    } else if (have.call_sign === callSign && !have.name && name) await cs.set("license", id, "name", name);
  };
  for (const s of obs.system.sites) for (const c of s.heard?.callSigns ?? []) await license(c.freqHz, c.callSign, "", "air");
  for (const [k, v] of Object.entries(obs.system.fcc ?? {})) await license(Number(k), v.callSign, v.name ?? "", v.from ?? "user");

  // ── names, and talkgroups ──
  const tgs = await cs.query("talkgroup", "system_id = ?", [sys], (r) => r.system_id === sys);
  const byNumber = new Map(tgs.map((t) => [t.number as number, t]));
  const names = await NameIndex.load(cs, [sys, ...siteIds, ...tgs.map((t) => t.id as string)]);
  // What the recorder had when it imported (only changes from it count).
  const base = obs.directory && (await resolve(db, obs.directory.id)) === sys ? await valuesAt(db, sys, obs.directory.rev) : null;
  const echo = (id: string, field: string, v: string) => base !== null && String(base.get(id)?.[field] ?? "") === v;
  if (obs.system.name && !echo(sys, "name", obs.system.name)) await names.assert("system", sys, "name", obs.system.name, obs.recorder);
  for (const [i, s] of obs.system.sites.entries()) {
    if (s.name && !echo(siteIds[i], "name", s.name)) await names.assert("site", siteIds[i], "name", s.name, obs.recorder);
  }
  const ensureTg = async (number: number, status: string) => {
    let t = byNumber.get(number);
    if (!t) {
      t = await cs.create("talkgroup", {
        system_id: sys, number, alpha: "", description: "", mode: "", tag: "", category: "", priority: "", status, merged_into: null,
        first_heard: null, last_heard: null, grants: 0, encrypted: 0,
      });
      byNumber.set(number, t);
    }
    return t;
  };
  for (const t of obs.talkgroups ?? []) {
    const row = await ensureTg(t.number, "active");
    const id = row.id as string;
    if (row.status === "heard" && t.alpha) await cs.set("talkgroup", id, "status", "active");
    for (const f of TG_FIELDS) {
      const v = t[f];
      if (!v || echo(id, f, v)) continue;
      await names.assert("talkgroup", id, f, v, obs.recorder);
    }
  }
  const tgSites: unknown[][] = [];
  for (const h of obs.heardTalkgroups ?? []) {
    const row = await ensureTg(h.number, "heard");
    const id = row.id as string;
    await cs.stat("talkgroup", id, { last_heard: now, first_heard: row.first_heard ?? now, encrypted: h.encrypted || row.encrypted ? 1 : 0 }, { grants: h.grants });
    for (const k of h.sites ?? []) tgSites.push([id, siteIds[k], h.grants, now, now]);
  }
  cs.raw(...insertRows("talkgroup_sites", ["talkgroup_id", "site_id", "grants", "first_heard", "last_heard"], tgSites, "ON CONFLICT (talkgroup_id, site_id) DO UPDATE SET grants = grants + excluded.grants, last_heard = excluded.last_heard"));
  cs.bump(sys);

  const revs = await cs.commit();
  await reindex(db, sys);
  const rev = revs.get(sys) ?? ((await db.all<{ rev: number }>("SELECT rev FROM systems WHERE id = ?", [sys]))[0]?.rev ?? 0);
  return { systemId: sys, rev, created, sites: siteIds, merged: [], changesetId: cs.empty ? null : cs.id, mergeWith: [...mergeWith].map(([id, e]) => ({ id, ...e })) };
}

/**
 * Each record of system `sys` as it was at version `rev`: field → value (the
 * revisioned fields), from its revisions. For telling a recorder's edits from
 * what it imported.
 */
export async function valuesAt(db: Db, sys: string, rev: number): Promise<Map<string, Record<string, unknown>>> {
  const rows = await db.all<{ record_id: string; field: string; after: string | null }>(
    `SELECT r.record_id, r.field, r.after FROM revisions r JOIN system_revs v ON v.changeset_id = r.changeset_id
      WHERE v.system_id = ? AND v.rev <= ? AND r.record_kind IN ('system', 'site', 'talkgroup') ORDER BY r.seq`,
    [sys, rev],
  );
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const v = r.after === null ? null : JSON.parse(r.after);
    if (r.field === "*") {
      if (v) out.set(r.record_id, { ...v });
      else out.delete(r.record_id);
    } else {
      const e = out.get(r.record_id) ?? {};
      e[r.field] = v;
      out.set(r.record_id, e);
    }
  }
  return out;
}

/** The search index's rows for a system, again (its name, sites', talkgroups'). */
export async function reindex(db: Db, sys: string): Promise<void> {
  const s = (await db.all<Row>("SELECT id, name, type, status FROM systems WHERE id = ?", [sys]))[0];
  const rows: unknown[][] = [];
  if (s && s.status === "active") {
    // Its name, and who holds its licenses (and their call signs): a system is found by any.
    const lic = await db.all<Row>(
      `SELECT DISTINCT x.licensee AS who, x.call_sign AS cs FROM site_transmitters x JOIN sites t ON t.id = x.site_id WHERE t.system_id = ?
       UNION SELECT name, call_sign FROM fcc_licenses WHERE system_id = ?`,
      [sys, sys],
    );
    const words = [...new Set(lic.flatMap((l) => [l.who as string, l.cs as string]).filter(Boolean))];
    rows.push([sys, sys, "system", [s.name ?? "", ...words].filter(Boolean).join(" ")]);
    for (const t of await db.all<Row>("SELECT id, number, alpha, description, tag, category FROM talkgroups WHERE system_id = ? AND status IN ('active', 'heard')", [sys])) {
      const text = [t.alpha, t.description, t.tag, t.category].filter(Boolean).join(" ");
      if (text) rows.push([t.id, sys, "talkgroup", text]);
    }
    for (const x of await db.all<Row>("SELECT id, name FROM sites WHERE system_id = ? AND name != ''", [sys])) rows.push([x.id, sys, "site", x.name]);
  }
  await db.batch([{ sql: "DELETE FROM search_fts WHERE system_id = ?", params: [sys] }, ...insertRows("search_fts", ["record_id", "system_id", "kind", "text"], rows)]);
}
