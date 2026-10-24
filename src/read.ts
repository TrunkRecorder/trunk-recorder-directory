// Reading the directory: a system as it is (or was, at any version), its
// talkgroups, search, history. (What's near a place: explore.ts.)

import { type Db, type Row, first, marks } from "./db.ts";
import { resolve } from "./share.ts";

export interface SiteView {
  id: string;
  name: string;
  rfss: number | null;
  site: number | null;
  nac: number | null;
  status: string;
  modulation: string;
  bandplan: unknown;
  lat: number | null;
  lon: number | null;
  controlChannelsHz: number[];
  voiceChannelsHz: number[];
  neighbours: string[];
  firstHeard: number | null;
  lastHeard: number | null;
}

export interface SystemView {
  id: string;
  rev: number;
  type: string;
  name: string;
  /** Who holds most of its towers' licenses (place.ts): what it's called when no one has named it. */
  licensee: string;
  wacn: number | null;
  sysId: number | null;
  status: string;
  mergedInto: string | null;
  lat: number | null;
  lon: number | null;
  createdAt: number;
  updatedAt: number;
  sites: SiteView[];
  licenses: Record<string, { callSign: string; name: string; source: string }>;
  talkgroupCount: number;
}

export interface TalkgroupView {
  id: string;
  number: number;
  alpha: string;
  description: string;
  mode: string;
  tag: string;
  category: string;
  priority: string;
  status: string;
  firstHeard: number | null;
  lastHeard: number | null;
  grants: number;
  encrypted: boolean;
  /** Sites it's been granted on. */
  sites: string[];
  /** Other names people gave it (with their support), when there are. */
  alternatives?: { field: string; value: string; supporters: number }[];
}

type Records = Map<string, Map<string, Row>>;

/** The system's records as they are now: kind → id → row. */
async function current(db: Db, id: string): Promise<Records> {
  const out: Records = new Map();
  const put = (kind: string, rows: Row[]) => {
    const m = out.get(kind) ?? new Map<string, Row>();
    for (const r of rows) m.set(r.id as string, r);
    out.set(kind, m);
  };
  put("system", await db.all("SELECT * FROM systems WHERE id = ?", [id]));
  const sites = await db.all("SELECT * FROM sites WHERE system_id = ?", [id]);
  put("site", sites);
  const sids = sites.map((s) => s.id);
  put("freq", sids.length ? await db.all(`SELECT * FROM site_freqs WHERE site_id IN (${marks(sids.length)})`, sids) : []);
  put("neighbour", sids.length ? await db.all(`SELECT * FROM site_neighbours WHERE site_id IN (${marks(sids.length)})`, sids) : []);
  put("talkgroup", await db.all("SELECT * FROM talkgroups WHERE system_id = ?", [id]));
  put("license", await db.all("SELECT * FROM fcc_licenses WHERE system_id = ?", [id]));
  return out;
}

const VIEW_KINDS = ["system", "site", "freq", "neighbour", "talkgroup", "license"];

/**
 * The system's records as they were at version `rev`: now, with every change
 * since undone in memory (records moved in or out by a merge included).
 */
async function asOf(db: Db, id: string, rev: number): Promise<Records> {
  const recs = await current(db, id);
  const revs = await db.all<{ record_kind: string; record_id: string; field: string; before: string | null }>(
    `SELECT r.record_kind, r.record_id, r.field, r.before FROM revisions r JOIN system_revs v ON v.changeset_id = r.changeset_id
      WHERE v.system_id = ? AND v.rev > ? ORDER BY r.seq DESC`,
    [id, rev],
  );
  // Records changed since that aren't here now (moved out): read them too.
  for (const r of revs) {
    if (!VIEW_KINDS.includes(r.record_kind) || recs.get(r.record_kind)?.has(r.record_id)) continue;
    const table = { system: "systems", site: "sites", freq: "site_freqs", neighbour: "site_neighbours", talkgroup: "talkgroups", license: "fcc_licenses" }[r.record_kind]!;
    const row = await first(db, `SELECT * FROM ${table} WHERE id = ?`, [r.record_id]);
    if (row) recs.get(r.record_kind)!.set(r.record_id, row);
  }
  for (const r of revs) {
    const m = recs.get(r.record_kind);
    if (!m) continue;
    const before = r.before === null ? null : JSON.parse(r.before);
    if (r.field === "*") {
      if (before === null) m.delete(r.record_id);
      else m.set(r.record_id, { ...before });
    } else {
      const row = m.get(r.record_id);
      if (row) row[r.field] = before;
    }
  }
  // What was the system's then.
  const sites = recs.get("site")!;
  for (const [k, s] of sites) if (s.system_id !== id) sites.delete(k);
  for (const kind of ["talkgroup", "license"]) for (const [k, x] of recs.get(kind)!) if (x.system_id !== id) recs.get(kind)!.delete(k);
  for (const kind of ["freq", "neighbour"]) for (const [k, x] of recs.get(kind)!) if (!sites.has(x.site_id as string)) recs.get(kind)!.delete(k);
  const sys = recs.get("system")!.get(id);
  if (sys) sys.rev = rev;
  return recs;
}

async function records(db: Db, id: string, rev?: number): Promise<Records | null> {
  const sys = await first<Row>(db, "SELECT rev FROM systems WHERE id = ?", [id]);
  if (!sys) return null;
  return rev !== undefined && rev < (sys.rev as number) ? asOf(db, id, rev) : current(db, id);
}

function systemView(recs: Records): SystemView | null {
  const s = [...recs.get("system")!.values()][0];
  if (!s) return null;
  const freqs = [...recs.get("freq")!.values()];
  const sites: SiteView[] = [...recs.get("site")!.values()]
    .filter((x) => x.status !== "merged")
    .map((x) => ({
      id: x.id as string,
      name: x.name as string,
      rfss: x.rfss as number | null,
      site: x.site as number | null,
      nac: x.nac as number | null,
      status: x.status as string,
      modulation: x.modulation as string,
      bandplan: x.bandplan ? JSON.parse(x.bandplan as string) : null,
      lat: x.lat as number | null,
      lon: x.lon as number | null,
      controlChannelsHz: freqs.filter((f) => f.site_id === x.id && f.use === "control").map((f) => f.freq_hz as number).sort((a, b) => a - b),
      voiceChannelsHz: freqs.filter((f) => f.site_id === x.id && f.use === "voice").map((f) => f.freq_hz as number).sort((a, b) => a - b),
      neighbours: [...recs.get("neighbour")!.values()].filter((n) => n.site_id === x.id).map((n) => n.neighbour_id as string),
      firstHeard: x.first_heard as number | null,
      lastHeard: x.last_heard as number | null,
    }))
    .sort((a, b) => (a.rfss ?? 999) - (b.rfss ?? 999) || (a.site ?? 999) - (b.site ?? 999) || a.id.localeCompare(b.id));
  // The best license on each frequency: the user's, then the air's, then a lookup's.
  const rank = { user: 0, air: 1, lookup: 2 } as Record<string, number>;
  const licenses: SystemView["licenses"] = {};
  for (const l of [...recs.get("license")!.values()].sort((a, b) => (rank[a.source as string] ?? 3) - (rank[b.source as string] ?? 3))) {
    licenses[String(l.freq_hz)] ??= { callSign: l.call_sign as string, name: l.name as string, source: l.source as string };
  }
  return {
    id: s.id as string,
    rev: s.rev as number,
    type: s.type as string,
    name: s.name as string,
    licensee: (s.licensee as string | undefined) ?? "",
    wacn: s.wacn as number | null,
    sysId: s.sys_id as number | null,
    status: s.status as string,
    mergedInto: s.merged_into as string | null,
    lat: s.lat as number | null,
    lon: s.lon as number | null,
    createdAt: s.created_at as number,
    updatedAt: s.updated_at as number,
    sites,
    licenses,
    talkgroupCount: [...recs.get("talkgroup")!.values()].filter((t) => t.status === "active" || t.status === "heard").length,
  };
}

/** A system, as it is or was at version `rev`. Null: no such system. A merged one says what it went into. */
export async function getSystem(db: Db, id: string, rev?: number): Promise<SystemView | null> {
  const recs = await records(db, id, rev);
  if (!recs) return null;
  return systemView(recs);
}

/** A system's talkgroups (active and heard-not-named), with where each is heard and other names people gave. */
export async function getTalkgroups(db: Db, id: string, opts: { rev?: number; sites?: string[] } = {}): Promise<TalkgroupView[] | null> {
  const recs = await records(db, id, opts.rev);
  if (!recs) return null;
  const tgs = [...recs.get("talkgroup")!.values()].filter((t) => t.status === "active" || t.status === "heard");
  const ids = tgs.map((t) => t.id as string);
  const where = new Map<string, string[]>();
  const alts = new Map<string, { field: string; value: string; supporters: number }[]>();
  // (45 at a time: the first query binds them twice, under D1's 100 parameters.)
  for (let i = 0; i < ids.length; i += 45) {
    const some = ids.slice(i, i + 45);
    // (Including talkgroups merged into these: their heard sites are theirs.)
    for (const r of await db.all<{ tg: string; site_id: string }>(
      `SELECT COALESCE(t.merged_into, ts.talkgroup_id) AS tg, ts.site_id FROM talkgroup_sites ts JOIN talkgroups t ON t.id = ts.talkgroup_id
        WHERE ts.talkgroup_id IN (${marks(some.length)}) OR t.merged_into IN (${marks(some.length)})`,
      [...some, ...some],
    )) where.set(r.tg, [...new Set([...(where.get(r.tg) ?? []), r.site_id])]);
    for (const r of await db.all<{ record_id: string; field: string; value: string; n: number }>(
      `SELECT c.record_id, c.field, c.value, COUNT(s.id) AS n FROM candidates c LEFT JOIN supporters s ON s.candidate_id = c.id AND s.void = 0
        WHERE c.record_id IN (${marks(some.length)}) GROUP BY c.id`,
      some,
    )) alts.set(r.record_id, [...(alts.get(r.record_id) ?? []), { field: r.field, value: r.value, supporters: r.n }]);
  }
  let out: TalkgroupView[] = tgs.map((t) => {
    const others = (alts.get(t.id as string) ?? []).filter((a) => a.value !== t[a.field]);
    return {
      id: t.id as string,
      number: t.number as number,
      alpha: t.alpha as string,
      description: t.description as string,
      mode: t.mode as string,
      tag: t.tag as string,
      category: t.category as string,
      priority: t.priority as string,
      status: t.status as string,
      firstHeard: t.first_heard as number | null,
      lastHeard: t.last_heard as number | null,
      grants: t.grants as number,
      encrypted: !!t.encrypted,
      sites: where.get(t.id as string) ?? [],
      ...(others.length ? { alternatives: others } : {}),
    };
  });
  // Part of a big system: what's heard at these sites, and what's heard everywhere (interop) or nowhere yet.
  if (opts.sites?.length) {
    const want = new Set(opts.sites);
    const all = new Set([...recs.get("site")!.values()].filter((s) => s.status === "heard").map((s) => s.id as string));
    out = out.filter((t) => !t.sites.length || t.sites.some((s) => want.has(s)) || (all.size > 1 && t.sites.length >= all.size));
  }
  return out.sort((a, b) => a.number - b.number);
}

const csvField = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Talkgroups as Trunk Recorder's talkgroup file (what TRP reads). */
export function talkgroupsCsv(tgs: TalkgroupView[]): string {
  const rows = ["Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category,Priority"];
  for (const t of tgs) {
    rows.push([String(t.number), t.number.toString(16), t.alpha, t.mode || "D", t.description, t.tag, t.category, t.priority].map(csvField).join(","));
  }
  return rows.join("\n") + "\n";
}

/** A system as TRP's config has one (with its directory link), ready to add. `licensee`: who holds most of its licenses (an unnamed system's short name). */
export function trpSystem(s: SystemView, sites?: string[], licensee = ""): Record<string, unknown> {
  const pick = sites?.length ? s.sites.filter((x) => sites.includes(x.id)) : s.sites.filter((x) => x.status !== "retired");
  // Its short name: from its name, else who holds its licenses ("district-of-columbia"), else its ID.
  const slug = (s.name || licensee || s.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24).replace(/-+$/, "") || "system";
  return {
    shortName: slug,
    ...(s.name ? { name: s.name } : {}),
    type: s.type,
    enabled: true,
    ...(Object.keys(s.licenses).length
      ? { fcc: Object.fromEntries(Object.entries(s.licenses).map(([k, l]) => [k, { callSign: l.callSign, ...(l.name ? { name: l.name } : {}), from: l.source === "user" ? "lookup" : l.source }])) }
      : {}),
    directory: { id: s.id, rev: s.rev },
    sites: pick.map((x) => ({
      ...(x.name ? { name: x.name } : {}),
      enabled: true,
      controlChannelsHz: x.controlChannelsHz,
      modulation: x.modulation === "qpsk" || x.modulation === "fsk4" ? x.modulation : "auto",
      expect: {
        ...(x.nac != null ? { nac: x.nac } : {}),
        ...(s.wacn != null ? { wacn: s.wacn } : {}),
        ...(s.sysId != null ? { sysId: s.sysId } : {}),
        ...(x.rfss != null ? { rfss: x.rfss } : {}),
        ...(x.site != null ? { site: x.site } : {}),
      },
      voiceChannelsHz: x.voiceChannelsHz,
      ...(x.bandplan && typeof x.bandplan === "object" ? (x.bandplan as object) : {}),
      directoryId: x.id,
    })),
  };
}

export interface SearchHit {
  kind: "system" | "site" | "talkgroup" | "frequency" | "license" | "identity";
  systemId: string;
  systemName: string;
  id: string;
  label: string;
}

/** Search by anything: a frequency, a call sign, an identity (BEE00.3A9), a talkgroup number in a system, or words. */
export async function search(db: Db, q: string, opts: { system?: string; limit?: number } = {}): Promise<SearchHit[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const text = q.trim();
  if (!text) return [];
  const names = new Map<string, string>();
  const nameOf = async (id: string) => {
    // (Unnamed: who holds its licenses.)
    if (!names.has(id)) names.set(id, ((await first<Row>(db, "SELECT COALESCE(NULLIF(name, ''), licensee) AS name FROM systems WHERE id = ?", [id]))?.name as string) ?? "");
    return names.get(id)!;
  };
  const hits: SearchHit[] = [];
  // A frequency (MHz): uses within half a channel, or a prefix's range.
  const mhz = /^(\d{2,4})\.(\d{1,6})$/.exec(text);
  if (mhz) {
    const exact = mhz[2].length >= 4;
    const lo = Math.round(Number(text) * 1e6) - (exact ? 3125 : 0);
    const hi = exact ? lo + 6250 : Math.round(Number(`${mhz[1]}.${mhz[2]}9999`) * 1e6);
    for (const r of await db.all<Row>(
      `SELECT f.freq_hz, f.use, s.system_id, s.id AS site_id FROM site_freqs f JOIN sites s ON s.id = f.site_id
        JOIN systems y ON y.id = s.system_id WHERE f.freq_hz BETWEEN ? AND ? AND y.status = 'active' LIMIT ?`,
      [lo, hi, limit],
    )) hits.push({ kind: "frequency", systemId: r.system_id as string, systemName: await nameOf(r.system_id as string), id: r.site_id as string, label: `${(Number(r.freq_hz) / 1e6).toFixed(5)} MHz (${r.use})` });
    return hits;
  }
  // A call sign.
  if (/^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9]{3,8}$/.test(text)) {
    for (const r of await db.all<Row>(
      "SELECT l.system_id, l.freq_hz, l.call_sign, l.name FROM fcc_licenses l JOIN systems y ON y.id = l.system_id WHERE l.call_sign = ? AND y.status = 'active' LIMIT ?",
      [text.toUpperCase(), limit],
    )) hits.push({ kind: "license", systemId: r.system_id as string, systemName: await nameOf(r.system_id as string), id: r.system_id as string, label: `${r.call_sign} on ${(Number(r.freq_hz) / 1e6).toFixed(5)} MHz${r.name ? ` (${r.name})` : ""}` });
  }
  // An identity: WACN.SysID (hex).
  const ident = /^([0-9a-fA-F]{1,5})\.([0-9a-fA-F]{1,3})$/.exec(text);
  if (ident) {
    for (const r of await db.all<Row>("SELECT DISTINCT record_id FROM claims WHERE record_kind = 'system' AND (key = ? OR key LIKE ?) LIMIT ?", [`p25:${ident[1].toLowerCase()}.${ident[2].toLowerCase()}`, `p25:${ident[1].toLowerCase()}.${ident[2].toLowerCase()}@%`, limit])) {
      const id = await resolve(db, r.record_id as string);
      hits.push({ kind: "identity", systemId: id, systemName: await nameOf(id), id, label: `P25 ${ident[1].toUpperCase()}.${ident[2].toUpperCase()}` });
    }
  }
  // A talkgroup number, in a system.
  if (/^\d{1,8}$/.test(text) && opts.system) {
    for (const r of await db.all<Row>("SELECT id, number, alpha FROM talkgroups WHERE system_id = ? AND number = ? AND status IN ('active', 'heard')", [opts.system, Number(text)])) {
      hits.push({ kind: "talkgroup", systemId: opts.system, systemName: await nameOf(opts.system), id: r.id as string, label: `${r.number} ${r.alpha}` });
    }
  }
  // Words.
  const words = text.replace(/["*():^]/g, " ").split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(" ");
  if (words) {
    const rows = await db.all<Row>(
      `SELECT record_id, system_id, kind, text FROM search_fts WHERE search_fts MATCH ? ${opts.system ? "AND system_id = ?" : ""} ORDER BY rank LIMIT ?`,
      opts.system ? [words, opts.system, limit] : [words, limit],
    );
    for (const r of rows) hits.push({ kind: r.kind as SearchHit["kind"], systemId: r.system_id as string, systemName: await nameOf(r.system_id as string), id: r.record_id as string, label: r.text as string });
  }
  return hits.slice(0, limit);
}

export interface HistoryEntry {
  rev: number;
  changesetId: string;
  at: number;
  kind: string;
  actorKind: string;
  /** A recorder is shown by its kind only (its ID is never shown). */
  actor: string;
  note: string;
  revertsId: string | null;
  summary: Record<string, { added: number; changed: number; removed: number }>;
}

/** A system's versions, newest first, each with what changed. */
export async function history(db: Db, id: string, opts: { before?: number; limit?: number } = {}): Promise<HistoryEntry[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = await db.all<Row>(
    `SELECT v.rev, c.* FROM system_revs v JOIN changesets c ON c.id = v.changeset_id
      WHERE v.system_id = ? ${opts.before ? "AND v.rev < ?" : ""} ORDER BY v.rev DESC LIMIT ?`,
    opts.before ? [id, opts.before, limit] : [id, limit],
  );
  const out: HistoryEntry[] = [];
  for (const r of rows) {
    const summary: HistoryEntry["summary"] = {};
    for (const x of await db.all<{ record_kind: string; field: string; before: string | null; after: string | null }>("SELECT record_kind, field, before IS NULL AS b, after IS NULL AS a, before, after FROM revisions WHERE changeset_id = ?", [r.id])) {
      if (["claim", "supporter", "candidate"].includes(x.record_kind)) continue;
      const e = (summary[x.record_kind] ??= { added: 0, changed: 0, removed: 0 });
      if (x.field === "*" && x.before === null) e.added++;
      else if (x.field === "*" && x.after === null) e.removed++;
      else e.changed++;
    }
    out.push({
      rev: r.rev as number,
      changesetId: r.id as string,
      at: r.at as number,
      kind: r.kind as string,
      actorKind: r.actor_kind as string,
      actor: r.actor_kind === "recorder" ? "a recorder" : (r.actor_id as string),
      note: r.note as string,
      revertsId: r.reverts_id as string | null,
      summary,
    });
  }
  return out;
}

/** A change set's field changes (records people read: not the bookkeeping). */
export async function changeset(db: Db, id: string): Promise<{ info: Row; revisions: Row[] } | null> {
  const info = await first<Row>(db, "SELECT id, at, actor_kind, kind, observation_id IS NOT NULL AS shared, reverts_id, note FROM changesets WHERE id = ?", [id]);
  if (!info) return null;
  const revisions = await db.all<Row>("SELECT record_kind, record_id, field, before, after FROM revisions WHERE changeset_id = ? AND record_kind NOT IN ('claim', 'supporter') ORDER BY seq", [id]);
  return { info, revisions: revisions.map((r) => ({ ...r, before: r.before === null ? null : JSON.parse(r.before as string), after: r.after === null ? null : JSON.parse(r.after as string) })) };
}

/** What changed between two versions: sites, talkgroups and licenses added, removed or changed. */
export async function diff(db: Db, id: string, from: number, to: number) {
  const [a, b] = [await getSystem(db, id, from), await getSystem(db, id, to)];
  const [ta, tb] = [await getTalkgroups(db, id, { rev: from }), await getTalkgroups(db, id, { rev: to })];
  if (!a || !b || !ta || !tb) return null;
  const tgKey = (t: TalkgroupView) => JSON.stringify([t.alpha, t.description, t.mode, t.tag, t.category, t.priority, t.status]);
  const ma = new Map(ta.map((t) => [t.number, t]));
  const mb = new Map(tb.map((t) => [t.number, t]));
  const siteKey = (s: SiteView) => JSON.stringify([s.name, s.status, s.controlChannelsHz, s.voiceChannelsHz]);
  const sa = new Map(a.sites.map((s) => [s.id, s]));
  const sb = new Map(b.sites.map((s) => [s.id, s]));
  return {
    from, to,
    name: a.name === b.name ? null : { from: a.name, to: b.name },
    sites: {
      added: b.sites.filter((s) => !sa.has(s.id)),
      removed: a.sites.filter((s) => !sb.has(s.id)),
      changed: b.sites.filter((s) => sa.has(s.id) && siteKey(sa.get(s.id)!) !== siteKey(s)).map((s) => ({ from: sa.get(s.id), to: s })),
    },
    talkgroups: {
      added: tb.filter((t) => !ma.has(t.number)),
      removed: ta.filter((t) => !mb.has(t.number)),
      changed: tb.filter((t) => ma.has(t.number) && tgKey(ma.get(t.number)!) !== tgKey(t)).map((t) => ({ from: ma.get(t.number), to: t })),
    },
    licenses: { from: a.licenses, to: b.licenses },
  };
}
