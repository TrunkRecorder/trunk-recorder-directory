// Two records found to be one system (docs/design.md, "What a merge does"):
// one change set, so it can be reverted. The other system's sites,
// talkgroups, licenses, claims and name candidates move to the one kept; a
// talkgroup both had is one, its candidates pooled and its names chosen again;
// a site both had is one; every moved-away ID redirects.

import type { Db, Row } from "./db.ts";
import { NameIndex } from "./names.ts";
import { reindex, resolve } from "./share.ts";
import { sameSite } from "./sites.ts";
import { ChangeSet, type ChangeSetInfo } from "./store.ts";

const TG_FIELDS = ["alpha", "description", "mode", "tag", "category", "priority"];

export interface MergeResult {
  kept: string;
  gone: string;
  changesetId: string;
  rev: number;
}

/** Which of two systems a merge keeps: the older, and so the one more recorders link to. */
export async function keeper(db: Db, a: string, b: string): Promise<[string, string]> {
  const rows = await db.all<{ id: string; created_at: number }>("SELECT id, created_at FROM systems WHERE id IN (?, ?)", [a, b]);
  const at = (id: string) => rows.find((r) => r.id === id)?.created_at ?? Infinity;
  return at(a) <= at(b) ? [a, b] : [b, a];
}

export async function mergeSystems(db: Db, keepId: string, goneId: string, info: Omit<ChangeSetInfo, "kind">, why = ""): Promise<MergeResult> {
  keepId = await resolve(db, keepId);
  goneId = await resolve(db, goneId);
  if (keepId === goneId) throw new Error("they're one system already");
  const cs = new ChangeSet(db, { ...info, kind: "merge", note: why });
  const keep = await cs.get("system", keepId);
  const gone = await cs.get("system", goneId);
  if (!keep || !gone) throw new Error("no such system");
  if (keep.type !== gone.type) throw new Error("they're different kinds of system");

  for (const f of ["wacn", "sys_id", "lat", "lon"] as const) if (keep[f] == null && gone[f] != null) await cs.set("system", keepId, f, gone[f]);

  // Sites: one that is the same site (sites.ts) is one.
  const keepSites = await withControl(cs, await cs.query("site", "system_id = ?", [keepId], (r) => r.system_id === keepId));
  const goneSites = await withControl(cs, await cs.query("site", "system_id = ?", [goneId], (r) => r.system_id === goneId));
  for (const s of goneSites) {
    const twin = s.status === "merged" ? undefined : keepSites.find((k) => k.status !== "merged" && sameSite(k, s));
    if (!twin) await cs.set("site", s.id as string, "system_id", keepId);
    else await absorbSite(cs, s, twin);
  }

  // Talkgroups: one number, one talkgroup; its candidates pooled.
  const keepTgs = new Map((await cs.query("talkgroup", "system_id = ?", [keepId], (r) => r.system_id === keepId)).map((t) => [t.number as number, t]));
  const goneTgs = await cs.query("talkgroup", "system_id = ?", [goneId], (r) => r.system_id === goneId);
  const pooled: string[] = [];
  for (const t of goneTgs) {
    const id = t.id as string;
    const twin = keepTgs.get(t.number as number);
    if (!twin || t.status === "merged") {
      await cs.set("talkgroup", id, "system_id", keepId);
      continue;
    }
    const twinId = twin.id as string;
    for (const c of await cs.query("candidate", "record_id = ?", [id], (r) => r.record_id === id)) await cs.set("candidate", c.id as string, "record_id", twinId);
    for (const l of await cs.query("lock", "record_id = ?", [id], (r) => r.record_id === id)) await cs.set("lock", l.id as string, "record_id", twinId);
    // The twin's own values, if it had none.
    for (const f of TG_FIELDS) if (!twin[f] && t[f]) await cs.set("talkgroup", twinId, f, t[f]);
    if (twin.status === "heard" && t.status === "active") await cs.set("talkgroup", twinId, "status", "active");
    await cs.set("talkgroup", id, "status", "merged");
    await cs.set("talkgroup", id, "merged_into", twinId);
    await cs.create("redirect", { id, new_id: twinId });
    pooled.push(twinId);
  }

  for (const l of await cs.query("license", "system_id = ?", [goneId], (r) => r.system_id === goneId)) await cs.set("license", l.id as string, "system_id", keepId);
  for (const c of await cs.query("claim", "record_id = ?", [goneId], (r) => r.record_id === goneId)) await cs.set("claim", c.id as string, "record_id", keepId);
  for (const c of await cs.query("candidate", "record_id = ?", [goneId], (r) => r.record_id === goneId)) await cs.set("candidate", c.id as string, "record_id", keepId);

  // Names chosen again where candidates were pooled.
  const names = await NameIndex.load(cs, [keepId, ...pooled]);
  await names.choose("system", keepId, "name");
  for (const id of pooled) for (const f of TG_FIELDS) await names.choose("talkgroup", id, f);

  await cs.set("system", goneId, "status", "merged");
  await cs.set("system", goneId, "merged_into", keepId);
  await cs.create("redirect", { id: goneId, new_id: keepId });
  await db.batch([{ sql: "UPDATE merge_proposals SET status = 'merged', changeset_id = ? WHERE status = 'open' AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))", params: [cs.id, keepId, goneId, goneId, keepId] }]);
  const revs = await cs.commit();
  await reindex(db, keepId);
  await reindex(db, goneId);
  return { kept: keepId, gone: goneId, changesetId: cs.id, rev: revs.get(keepId) ?? 0 };
}

type SiteRow = Row & { rfss: number | null; site: number | null; controlHz: number[] };

/** Sites with their control channels, as sites.ts compares them. */
async function withControl(cs: ChangeSet, sites: Row[]): Promise<SiteRow[]> {
  const out: SiteRow[] = [];
  for (const s of sites) {
    const id = s.id as string;
    const cc = await cs.query("freq", "site_id = ? AND use = 'control'", [id], (r) => r.site_id === id && r.use === "control");
    out.push({ ...s, rfss: s.rfss as number | null, site: s.site as number | null, controlHz: cc.map((f) => f.freq_hz as number) });
  }
  return out;
}

/** Site `gone` is site `twin`: its channels, neighbour links and claims move there, and its ID redirects. */
async function absorbSite(cs: ChangeSet, gone: Row, twin: Row): Promise<void> {
  const id = gone.id as string;
  const twinId = twin.id as string;
  const have = new Set((await cs.query("freq", "site_id = ?", [twinId], (r) => r.site_id === twinId)).map((f) => `${f.use}:${f.freq_hz}`));
  for (const f of await cs.query("freq", "site_id = ?", [id], (r) => r.site_id === id)) {
    // A channel both had is the twin's already.
    if (!have.has(`${f.use}:${f.freq_hz}`)) await cs.set("freq", f.id as string, "site_id", twinId);
  }
  for (const n of await cs.query("neighbour", "site_id = ? OR neighbour_id = ?", [id, id], (r) => r.site_id === id || r.neighbour_id === id)) {
    if (n.site_id === id) await cs.set("neighbour", n.id as string, "site_id", twinId);
    if (n.neighbour_id === id) await cs.set("neighbour", n.id as string, "neighbour_id", twinId);
  }
  for (const c of await cs.query("claim", "record_id = ?", [id], (r) => r.record_id === id)) await cs.set("claim", c.id as string, "record_id", twinId);
  if (twin.status === "announced" && gone.status === "heard") await cs.set("site", twinId, "status", "heard");
  for (const f of ["name", "nac", "rfss", "site"] as const) if (twin[f] == null || twin[f] === "") if (gone[f] != null && gone[f] !== "") await cs.set("site", twinId, f, gone[f]);
  await cs.set("site", id, "status", "merged");
  await cs.set("site", id, "merged_into", twinId);
  await cs.create("redirect", { id, new_id: twinId });
}

/**
 * A system's own sites that are one site (sites.ts), recorded twice: a share
 * that named neither (a recorder's first share after an import, before site
 * IDs), before its sites could be matched within the system. The one first
 * heard is kept; the other redirects to it. Returns the sites merged away.
 */
export async function mergeSiteTwins(db: Db, systemId: string, info: Omit<ChangeSetInfo, "kind">): Promise<string[]> {
  const cs = new ChangeSet(db, { ...info, kind: "merge", note: "the same site, recorded twice" });
  const sites = (await withControl(cs, await cs.query("site", "system_id = ?", [systemId], (r) => r.system_id === systemId)))
    .filter((s) => s.status === "heard" || s.status === "announced")
    .sort((a, b) => ((a.first_heard as number) ?? Infinity) - ((b.first_heard as number) ?? Infinity) || String(a.id).localeCompare(String(b.id)));
  const gone: string[] = [];
  for (const [i, s] of sites.entries()) {
    if (gone.includes(s.id as string)) continue;
    for (const t of sites.slice(i + 1)) {
      if (gone.includes(t.id as string) || !sameSite(s, t)) continue;
      await absorbSite(cs, t, s);
      // What it had is the kept one's now (a third may match on it).
      s.controlHz = [...new Set([...s.controlHz, ...t.controlHz])];
      gone.push(t.id as string);
    }
  }
  if (!gone.length) return [];
  cs.bump(systemId);
  await cs.commit();
  await reindex(db, systemId);
  return gone;
}
