// The directory's API, under /directory/api/v1. Platform-agnostic: worker.ts
// (D1, R2) and dev.ts (SQLite, files) give it a database and a place for shares.
//
// Reads are open. A share (POST /observations) needs no account: it carries
// the install's anonymous recorder ID, and the Worker rate-limits it. Steward
// and admin actions need the ADMIN_TOKEN until there are accounts.

import { type Db, type Row, first } from "./db.ts";
import { newId } from "./ids.ts";
import { keeper, mergeSystems } from "./merge.ts";
import { NameIndex } from "./names.ts";
import { Invalid, parseObservation } from "./observation.ts";
import { changeset, diff, getSystem, getTalkgroups, history, near, search, talkgroupsCsv, trpSystem } from "./read.ts";
import { city, county, countyCounts, LICENSED_MAX_DEG, licensed, mapSites, nearby, parseTypes, placesNamed, state, states } from "./explore.ts";
import { cellCenter, validCell } from "./geo.ts";
import { placeSystem } from "./place.ts";
import type { Places } from "./places.ts";
import { revertActor, revertChangeset, revertSystemTo } from "./revert.ts";
import { applyShare, matchShare, reindex, resolve } from "./share.ts";
import { ChangeSet, type KindName, PREFIX_KIND } from "./store.ts";

export const BASE = "/directory/api/v1";

export interface Env {
  db: Db;
  /** Where a share is kept as it came (R2 in the Worker). */
  putObservation(key: string, body: string): Promise<void>;
  adminToken?: string;
  now?: () => number;
  /** ArgusRF's FCC database (read only) and the Census boundaries: for placing sites (place.ts). */
  fcc?: Db;
  places?: Places;
}

const MAX_BODY = 4 << 20;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": status === 200 ? "public, max-age=60" : "no-store", ...headers },
  });
}
const err = (status: number, message: string) => json({ error: message }, status);

/** A merged system's old ID answers with where it went (TRP relinks). */
async function systemOr301(env: Env, id: string, url: URL): Promise<string | Response> {
  const now = await resolve(env.db, id);
  if (now === id) return id;
  const to = url.pathname.replace(id, now) + url.search;
  return json({ movedTo: now }, 301, { location: to });
}

export function isAdmin(env: Pick<Env, "adminToken">, req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const token = env.adminToken;
  if (!token || !auth.startsWith("Bearer ")) return false;
  const a = new TextEncoder().encode(auth.slice(7));
  const b = new TextEncoder().encode(token);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function body(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Invalid("too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Invalid("invalid JSON");
  }
}

const num = (v: string | null) => (v === null || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);

export async function handle(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.slice(BASE.length) || "/";
  const q = url.searchParams;
  const db = env.db;
  const m = (re: RegExp) => re.exec(path);
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" } });
    }
    if (req.method === "GET") {
      if (path === "/systems") {
        const radius = Math.min(num(q.get("radiusKm")) ?? 50, 250);
        return json({ systems: await near(db, { cell: q.get("cell"), lat: num(q.get("lat")), lon: num(q.get("lon")) }, radius) });
      }
      let r = m(/^\/systems\/(sys_[0-9a-z]+)$/);
      if (r) {
        const id = await systemOr301(env, r[1], url);
        if (typeof id !== "string") return id;
        const s = await getSystem(db, id, num(q.get("rev")));
        if (!s || s.status === "hidden") return err(404, "no such system");
        return json(s, 200, { etag: `"${s.id}.${s.rev}"` });
      }
      r = m(/^\/systems\/(sys_[0-9a-z]+)\/talkgroups(\.csv)?$/);
      if (r) {
        const id = await systemOr301(env, r[1], url);
        if (typeof id !== "string") return id;
        const sites = q.get("sites")?.split(",").filter(Boolean);
        const tgs = await getTalkgroups(db, id, { rev: num(q.get("rev")), sites });
        if (!tgs) return err(404, "no such system");
        if (r[2]) return new Response(talkgroupsCsv(tgs), { headers: { "content-type": "text/csv; charset=utf-8", "access-control-allow-origin": "*" } });
        return json({ talkgroups: tgs });
      }
      r = m(/^\/systems\/(sys_[0-9a-z]+)\/config$/);
      if (r) {
        const id = await systemOr301(env, r[1], url);
        if (typeof id !== "string") return id;
        const s = await getSystem(db, id);
        if (!s || s.status === "hidden") return err(404, "no such system");
        const sites = q.get("sites")?.split(",").filter(Boolean);
        const tgs = (await getTalkgroups(db, id, { sites }))!.filter((t) => t.alpha || q.get("all") === "1");
        return json({ system: trpSystem(s, sites), talkgroupsCsv: talkgroupsCsv(tgs) }, 200, { etag: `"${s.id}.${s.rev}"` });
      }
      r = m(/^\/systems\/(sys_[0-9a-z]+)\/history$/);
      if (r) return json({ history: await history(db, await resolve(db, r[1]), { before: num(q.get("before")) }) });
      r = m(/^\/systems\/(sys_[0-9a-z]+)\/diff$/);
      if (r) {
        const from = num(q.get("from"));
        const to = num(q.get("to"));
        if (from === undefined || to === undefined) return err(400, "from and to are versions");
        const d = await diff(db, await resolve(db, r[1]), from, to);
        return d ? json(d) : err(404, "no such system");
      }
      r = m(/^\/systems\/(sys_[0-9a-z]+)\/candidates$/);
      if (r) {
        const id = await resolve(db, r[1]);
        const cs = new ChangeSet(db, { actorKind: "system", actorId: "read", kind: "edit" });
        const tgs = await db.all<Row>("SELECT id FROM talkgroups WHERE system_id = ? AND status IN ('active', 'heard')", [id]);
        const names = await NameIndex.load(cs, [id, ...tgs.map((t) => t.id as string)]);
        const out: Record<string, Record<string, unknown>> = {};
        for (const t of tgs) {
          for (const f of ["alpha", "description", "tag", "category", "mode"]) {
            const v = names.view(t.id as string, f);
            if (v.length > 1) (out[t.id as string] ??= {})[f] = v;
          }
        }
        return json({ candidates: out }, 200, { "cache-control": "no-store" });
      }
      r = m(/^\/changesets\/(cs_[0-9a-z]+)$/);
      if (r) {
        const c = await changeset(db, r[1]);
        return c ? json(c) : err(404, "no such change set");
      }
      if (path === "/search") {
        const types = parseTypes(q.get("types"));
        let hits = await search(db, q.get("q") ?? "", { system: q.get("system") ?? undefined });
        if (q.get("types")) {
          const kinds = new Map<string, string>();
          for (const h of hits) if (!kinds.has(h.systemId)) kinds.set(h.systemId, ((await first<Row>(db, "SELECT type FROM systems WHERE id = ?", [h.systemId]))?.type as string) ?? "");
          hits = hits.filter((h) => types.includes(kinds.get(h.systemId) ?? ""));
        }
        return json({ hits, places: q.get("system") ? [] : await placesNamed(db, q.get("q") ?? "") });
      }
      // ── exploring: by place, on the map, near a point ──
      const types = parseTypes(q.get("types"));
      if (path === "/places") return json(await states(db, types));
      r = m(/^\/places\/([A-Z]{2})$/);
      if (r) {
        const s = await state(db, r[1], types);
        return s ? json(s) : err(404, "no such state");
      }
      r = m(/^\/places\/([A-Z]{2})\/(\d{5})$/);
      if (r) {
        const c = await county(db, r[1], r[2], types);
        return c ? json(c) : err(404, "no such county");
      }
      r = m(/^\/places\/([A-Z]{2})\/(\d{5})\/(\d{7})$/);
      if (r) {
        const c = await city(db, r[1], r[2], r[3], types);
        return c ? json(c) : err(404, "no such city");
      }
      if (path === "/map/sites") return json({ sites: await mapSites(db, types) }, 200, { "cache-control": "public, max-age=300" });
      if (path === "/map/counties") return json({ counties: await countyCounts(db, types) }, 200, { "cache-control": "public, max-age=300" });
      if (path === "/map/licensed") {
        if (!env.fcc) return json({ licensed: [] });
        const b = (q.get("bbox") ?? "").split(",").map(Number);
        if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) return err(400, "bbox is west,south,east,north");
        const [west, south, east, north] = b;
        if (east - west > LICENSED_MAX_DEG || north - south > LICENSED_MAX_DEG || east <= west || north <= south) return json({ licensed: [], tooBig: true });
        return json({ licensed: await licensed(db, env.fcc, { west, south, east, north }) }, 200, { "cache-control": "public, max-age=3600" });
      }
      if (path === "/nearby") {
        // A coarse cell (what the page sends: ~3 km), or a point.
        const cell = validCell(q.get("cell"));
        const at: [number, number] | null = cell ? cellCenter(cell) : num(q.get("lat")) !== undefined && num(q.get("lon")) !== undefined ? [num(q.get("lat"))!, num(q.get("lon"))!] : null;
        if (!at) return err(400, "cell, or lat and lon");
        const radius = Math.min(num(q.get("radiusKm")) ?? 50, 250);
        // (A rough place: a little further, so what's in range of the real one is in.)
        return json({ at, systems: await nearby(db, at, radius + (cell || q.get("coarse") === "1" ? 4 : 0), types) });
      }
      if (path === "/identify") {
        const claim = (q.get("claim") ?? "").toLowerCase();
        if (!claim) return err(400, "claim is required");
        const rows = await db.all<Row>("SELECT record_kind, record_id, observations, last_seen FROM claims WHERE key = ? OR key LIKE ? ORDER BY observations DESC LIMIT 20", [claim, `${claim}@%`]);
        const out = [];
        for (const x of rows) out.push({ kind: x.record_kind, id: await resolve(db, x.record_id as string), observations: x.observations, lastSeen: x.last_seen });
        return json({ matches: out });
      }
      if (path === "/merge-proposals") return json({ proposals: await db.all("SELECT * FROM merge_proposals WHERE status = 'open' ORDER BY score DESC, at DESC LIMIT 100") }, 200, { "cache-control": "no-store" });
      if (path === "/meta") {
        const n = await first<Row>(db, "SELECT (SELECT COUNT(*) FROM systems WHERE status = 'active') AS systems, (SELECT COUNT(*) FROM sites) AS sites, (SELECT COUNT(*) FROM talkgroups) AS talkgroups, (SELECT COUNT(*) FROM observations) AS shares");
        return json({ v: 1, ...n });
      }
      return err(404, "not found");
    }

    if (req.method === "POST" && path === "/observations") return await share(env, req);

    // ── stewards and admins ──
    if (!isAdmin(env, req)) return err(401, "needs a steward's or an admin's token");
    const actor = { actorKind: "admin" as const, actorId: "admin" };
    let r = m(/^\/changesets\/(cs_[0-9a-z]+)\/revert$/);
    if (req.method === "POST" && r) return json(await revertChangeset(db, r[1], actor));
    r = m(/^\/systems\/(sys_[0-9a-z]+)\/revert$/);
    if (req.method === "POST" && r) {
      const b = (await body(req)) as { to?: number };
      if (typeof b?.to !== "number") return err(400, "to is a version");
      return json(await revertSystemTo(db, await resolve(db, r[1]), b.to, actor));
    }
    r = m(/^\/actors\/((?:r|a)_[0-9a-z]+)\/revert$/);
    if (req.method === "POST" && r) return json(await revertActor(db, r[1], actor));
    if (req.method === "POST" && path === "/merges") {
      const b = (await body(req)) as { a?: string; b?: string; why?: string };
      if (!b?.a || !b?.b) return err(400, "a and b are systems");
      const [keep, gone] = await keeper(db, await resolve(db, b.a), await resolve(db, b.b));
      return json(await mergeSystems(db, keep, gone, { ...actor, note: b.why ?? "" }, b.why ?? ""));
    }
    r = m(/^\/merge-proposals\/(mp_[0-9a-z]+)\/reject$/);
    if (req.method === "POST" && r) {
      await db.batch([{ sql: "UPDATE merge_proposals SET status = 'rejected' WHERE id = ?", params: [r[1]] }]);
      return json({ ok: true });
    }
    if (req.method === "POST" && path === "/quarantine") {
      const b = (await body(req)) as { actor?: string; reason?: string };
      if (!b?.actor) return err(400, "actor is required");
      await db.batch([{ sql: "INSERT OR REPLACE INTO quarantined (actor, at, reason) VALUES (?, ?, ?)", params: [b.actor, Date.now(), b.reason ?? ""] }]);
      return json({ ok: true });
    }
    r = m(/^\/quarantine\/((?:r|a)_[0-9a-z]+)$/);
    if (req.method === "DELETE" && r) {
      await db.batch([{ sql: "DELETE FROM quarantined WHERE actor = ?", params: [r[1]] }]);
      return json({ ok: true });
    }
    if (req.method === "POST" && path === "/locks") {
      const b = (await body(req)) as { id?: string; field?: string; value?: string; reason?: string };
      const kind = b?.id ? (PREFIX_KIND[b.id.split("_")[0]] as KindName | undefined) : undefined;
      if (!b?.id || !kind || !["talkgroup", "site", "system"].includes(kind) || !b.field || typeof b.value !== "string") return err(400, "id (a system, site or talkgroup), field and value");
      const cs = new ChangeSet(db, { ...actor, kind: "lock", note: b.reason ?? "" });
      const names = await NameIndex.load(cs, [b.id]);
      await names.lock(kind, b.id, b.field, b.value, actor.actorId, b.reason ?? "");
      const revs = await cs.commit();
      for (const s of revs.keys()) await reindex(db, s);
      return json({ changesetId: cs.id, systems: Object.fromEntries(revs) });
    }
    r = m(/^\/systems\/(sys_[0-9a-z]+)\/place$/);
    if (req.method === "POST" && r) {
      if (!env.fcc || !env.places) return err(400, "no FCC database here");
      return json(await placeSystem(db, env.fcc, env.places, await resolve(db, r[1]), { now: env.now?.() ?? Date.now(), force: true }));
    }
    if (req.method === "POST" && path === "/place") {
      if (!env.fcc || !env.places) return err(400, "no FCC database here");
      const out: Record<string, unknown> = {};
      for (const s of await db.all<Row>("SELECT id FROM systems WHERE status = 'active'")) out[s.id as string] = await placeSystem(db, env.fcc, env.places, s.id as string, { now: env.now?.() ?? Date.now(), force: q.get("force") === "1" });
      return json({ systems: out });
    }
    r = m(/^\/systems\/(sys_[0-9a-z]+)\/(hide|unhide|retire)$/);
    if (req.method === "POST" && r) {
      const cs = new ChangeSet(db, { ...actor, kind: r[2] === "retire" ? "retire" : "hide" });
      await cs.set("system", r[1], "status", r[2] === "hide" ? "hidden" : r[2] === "retire" ? "retired" : "active");
      const revs = await cs.commit();
      await reindex(db, r[1]);
      return json({ changesetId: cs.id, systems: Object.fromEntries(revs) });
    }
    return err(404, "not found");
  } catch (e) {
    if (e instanceof Invalid) return err(400, e.message);
    if (e instanceof Error && /^(no such|they're)/.test(e.message)) return err(400, e.message);
    throw e;
  }
}

/** A share from TRP: kept as it came, applied, and duplicates it shows merged (decisive) or proposed. */
async function share(env: Env, req: Request): Promise<Response> {
  const obs = parseObservation(await body(req));
  const db = env.db;
  const now = env.now?.() ?? Date.now();
  const id = newId("obs");
  const quarantined = await first(db, "SELECT actor FROM quarantined WHERE actor = ?", [obs.recorder]);
  const key = `${new Date(now).toISOString().slice(0, 10)}/${id}.json`;
  await env.putObservation(key, JSON.stringify(obs));
  if (quarantined) {
    await db.batch([{ sql: "INSERT INTO observations (id, recorder_id, at, app_version, cell, r2_key, status) VALUES (?, ?, ?, ?, ?, ?, 'quarantined')", params: [id, obs.recorder, now, obs.app, obs.cell ?? null, key] }]);
    // (Answered as if taken: a quarantined recorder isn't told.)
    return json({ observation: id, system: obs.directory?.id ?? null, rev: obs.directory?.rev ?? 0, sites: [], created: false, merged: [] }, 202);
  }
  // Decisive evidence that it's of two systems: merge them first, so the share lands on one.
  const merged: string[] = [];
  for (let i = 0; i < 4; i++) {
    const m = await matchShare(db, obs);
    const dec = m.mergeWith.filter((w) => w.decisive);
    if (!m.systemId || !dec.length) break;
    let into = m.systemId;
    for (const w of dec) {
      const [keep, gone] = await keeper(db, into, w.id);
      into = (await mergeSystems(db, keep, gone, { actorKind: "system", actorId: "matcher", note: w.why }, w.why)).kept;
      merged.push(gone);
    }
  }
  const res = await applyShare(db, obs, id, now);
  let systemId = res.systemId;
  for (const w of res.mergeWith) {
    if (w.decisive) {
      const [keep, gone] = await keeper(db, systemId, w.id);
      const mres = await mergeSystems(db, keep, gone, { actorKind: "system", actorId: "matcher", note: w.why }, w.why);
      merged.push(gone);
      systemId = mres.kept;
    } else {
      const open = await first(db, "SELECT id FROM merge_proposals WHERE ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))", [systemId, w.id, w.id, systemId]);
      if (!open) await db.batch([{ sql: "INSERT INTO merge_proposals (id, a_id, b_id, evidence, score, status, at) VALUES (?, ?, ?, ?, ?, 'open', ?)", params: [newId("mp"), systemId, w.id, JSON.stringify([w.why]), 1, now] }]);
    }
  }
  // Where its sites are, from the FCC licenses on their frequencies (a failure here doesn't fail the share).
  if (env.fcc && env.places) {
    try {
      await placeSystem(db, env.fcc, env.places, systemId, { now });
    } catch (e) {
      console.warn(`placing ${systemId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await db.batch([{ sql: "INSERT INTO observations (id, recorder_id, at, app_version, cell, system_id, base_rev, r2_key, status, changeset_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)", params: [id, obs.recorder, now, obs.app, obs.cell ?? null, systemId, obs.directory?.rev ?? null, key, res.changesetId] }]);
  const sites = [];
  for (const s of res.sites) sites.push(await resolve(db, s));
  const rev = (await first<{ rev: number }>(db, "SELECT rev FROM systems WHERE id = ?", [systemId]))?.rev ?? res.rev;
  return json({ observation: id, system: systemId, rev, sites, created: res.created, merged }, 201);
}
