// A system found twice: two records of one system, shared before either
// named the other (recorders at two ends of a statewide system, or before
// claims were what they are). After a system's sites are placed at their
// licensed towers, the records that are it are merged into one. The
// evidence, each only when nothing on the air disagrees (a WACN or a System
// ID that differs is another system, even under one license):
//
//   - the same licensed tower, under the same call sign;
//   - its weak identity (a default WACN, a SmartNet SysID) claimed in the
//     regions its towers are in, held by another there or in one around;
//   - the same FCC licensee: with the same identity, at any distance (State
//     of Indiana - IPSC's two ends are regions apart, under different call
//     signs); with no identity on one of them (DMR, a site not decoded yet),
//     towers within NEAR_KM.
//
// docs/design.md, "Identifiers".

import { type ClaimKeys, systemClaim } from "./claims.ts";
import { type Db, type Row, marks } from "./db.ts";
import { cellOf, distanceKm, regionOf } from "./geo.ts";
import { keeper, mergeSystems } from "./merge.ts";
import { placeSystem } from "./place.ts";
import type { Places } from "./places.ts";
import { claim, lookupClaims, resolve } from "./share.ts";
import { ChangeSet } from "./store.ts";

/** One licensee's towers this near, and no identity to tell them apart: one system. */
export const NEAR_KM = 50;

/** Words that name one licensee several ways ("MADISON, COUNTY OF", "Madison County"; "Co.", "Dept."). */
const SAME_WORD: Record<string, string> = { co: "county", cnty: "county", dept: "department", twp: "township", govt: "government", auth: "authority", st: "state" };
const LEFT_OUT = new Set(["of", "the", "and", "inc", "llc"]);

/** A licensee's name, as compared: lower case, its words sorted, punctuation and "of", "the" left out. */
export function licenseeKey(name: string): string {
  const words = name.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).map((w) => SAME_WORD[w] ?? w).filter((w) => w && !LEFT_OUT.has(w));
  return [...new Set(words)].sort().join(" ");
}

interface Sys {
  id: string;
  type: string;
  wacn: number | null;
  sys_id: number | null;
}

const differs = (a: unknown, b: unknown) => a != null && b != null && a !== b;
/** The air says they're two: a WACN or a System ID that differs. */
const disagree = (a: Sys, b: Sys) => differs(a.wacn, b.wacn) || differs(a.sys_id, b.sys_id);
const sameIdentity = (a: Sys, b: Sys) => a.sys_id != null && a.sys_id === b.sys_id && a.wacn === b.wacn;

async function towers(db: Db, systemId: string): Promise<{ lat: number; lon: number }[]> {
  return db.all("SELECT DISTINCT x.lat, x.lon FROM site_transmitters x JOIN sites s ON s.id = x.site_id WHERE s.system_id = ?", [systemId]);
}

/** Other active systems that are system `systemId`, each with why. Keeps its licensees and claims up to date. */
export async function twinsOf(db: Db, systemId: string, now: number): Promise<{ id: string; why: string }[]> {
  const me = (await db.all<Sys>("SELECT id, type, wacn, sys_id FROM systems WHERE id = ? AND status = 'active'", [systemId]))[0];
  if (!me) return [];
  const out = new Map<string, string>();
  const take = async (ids: string[], why: string) => {
    const rows = ids.length ? await db.all<Sys & { status: string }>(`SELECT id, type, wacn, sys_id, status FROM systems WHERE id IN (${marks(ids.length)})`, ids) : [];
    for (const o of rows) if (o.id !== me.id && o.status === "active" && o.type === me.type && !disagree(me, o) && !out.has(o.id)) out.set(o.id, why);
  };

  // The same tower, under the same call sign.
  const sameTower = await db.all<{ id: string }>(
    `SELECT DISTINCT s2.system_id AS id FROM site_transmitters a JOIN sites s1 ON s1.id = a.site_id
       JOIN site_transmitters b ON b.call_sign = a.call_sign AND ROUND(b.lat, 4) = ROUND(a.lat, 4) AND ROUND(b.lon, 4) = ROUND(a.lon, 4)
       JOIN sites s2 ON s2.id = b.site_id
      WHERE s1.system_id = ? AND s2.system_id != ?`,
    [systemId, systemId],
  );
  await take(sameTower.map((r) => r.id), "its licensed towers are this one's");

  // Its weak identity where its towers are, and around.
  const mine = await towers(db, systemId);
  const claims = [...new Set(mine.map((t) => regionOf(cellOf(t.lat, t.lon))))]
    .map((r) => systemClaim(me.type, { wacn: me.wacn ?? undefined, sysId: me.sys_id ?? undefined }, r))
    .filter((c): c is ClaimKeys => !!c && c.store[0].includes("@"));
  if (claims.length) {
    const cs = new ChangeSet(db, { actorKind: "system", actorId: "fcc", kind: "edit", note: "its identity where its towers are" }, now);
    await claim(cs, claims, "system", systemId);
    const hits = await lookupClaims(cs, claims, "system");
    await cs.commit();
    await take(hits.map((h) => h.id), "the same identity, where its licensed towers are");
  }

  // The same licensee: its names kept (an index), then those who share one.
  const names = await db.all<{ n: string }>(
    `SELECT DISTINCT x.licensee AS n FROM site_transmitters x JOIN sites s ON s.id = x.site_id WHERE s.system_id = ? AND x.licensee != ''
     UNION SELECT DISTINCT name AS n FROM fcc_licenses WHERE system_id = ? AND name != ''`,
    [systemId, systemId],
  );
  const keys = [...new Set(names.map((r) => licenseeKey(r.n)).filter(Boolean))];
  await db.batch([
    { sql: "DELETE FROM system_licensees WHERE system_id = ?", params: [systemId] },
    ...keys.map((k) => ({ sql: "INSERT OR IGNORE INTO system_licensees (system_id, key) VALUES (?, ?)", params: [systemId, k] })),
  ]);
  if (keys.length) {
    const others = await db.all<Sys & { key: string }>(
      `SELECT y.id, y.type, y.wacn, y.sys_id, l.key FROM system_licensees l JOIN systems y ON y.id = l.system_id
        WHERE l.key IN (${marks(keys.length)}) AND l.system_id != ? AND y.status = 'active' AND y.type = ?`,
      [...keys, systemId, me.type],
    );
    for (const o of others) {
      if (out.has(o.id) || disagree(me, o)) continue;
      if (sameIdentity(me, o)) {
        out.set(o.id, "the same identity, under the same FCC licensee");
        continue;
      }
      if (me.sys_id != null && o.sys_id != null) continue;
      const theirs = await towers(db, o.id);
      const near = mine.some((a) => theirs.some((b) => distanceKm([a.lat, a.lon], [b.lat, b.lon]) <= NEAR_KM));
      if (near) out.set(o.id, `the same FCC licensee's towers, within ${NEAR_KM} km, and nothing on the air says otherwise`);
    }
  }
  return [...out].map(([id, why]) => ({ id, why }));
}

/** Place a system's sites, then merge the records that are it into one. */
export async function placeJoining(db: Db, fcc: Db, places: Places, systemId: string, opts: { now: number; force?: boolean }) {
  const placed = await placeSystem(db, fcc, places, systemId, opts);
  const merged: string[] = [];
  for (const t of await twinsOf(db, systemId, opts.now)) {
    const twin = await resolve(db, t.id);
    if (merged.includes(twin) || twin === systemId) continue;
    const [keep, gone] = await keeper(db, systemId, twin);
    systemId = (await mergeSystems(db, keep, gone, { actorKind: "system", actorId: "matcher", note: t.why }, t.why)).kept;
    merged.push(gone);
  }
  return { ...placed, systemId, merged };
}
