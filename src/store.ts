// Writing records: every change goes through a ChangeSet, which keeps what each
// field was and became (a revision), and writes it all together at commit.
// That is what makes history, versions (a system's `rev`) and revert work the
// same for every kind of change, merges included: nothing is overwritten
// without its before.
//
// A ChangeSet reads through to the database and keeps what it changed in
// memory, so later reads in the same change set see its own writes. Evidence
// counters (`stats`: heard counts, first/last heard) change without revisions.

import { type Db, type Row, type Stmt, insertRows } from "./db.ts";
import { newId, type IdKind } from "./ids.ts";

interface Kind {
  table: string;
  key: string;
  prefix: IdKind | null;
  /** Revisioned columns. */
  fields: string[];
  /** Evidence columns: changed without revisions. */
  stats: string[];
  /** The field naming what it belongs to, whose system is its system (for versions). */
  of: string;
}

export const KINDS: Record<string, Kind> = {
  system: { table: "systems", key: "id", prefix: "sys", fields: ["type", "name", "wacn", "sys_id", "status", "merged_into", "lat", "lon", "created_at"], stats: ["updated_at"], of: "id" },
  site: { table: "sites", key: "id", prefix: "site", fields: ["system_id", "name", "rfss", "site", "nac", "modulation", "bandplan", "lat", "lon", "loc_source", "status", "merged_into"], stats: ["first_heard", "last_heard"], of: "system_id" },
  freq: { table: "site_freqs", key: "id", prefix: "fq", fields: ["site_id", "freq_hz", "use"], stats: ["first_heard", "last_heard", "grants"], of: "site_id" },
  neighbour: { table: "site_neighbours", key: "id", prefix: "nb", fields: ["site_id", "neighbour_id"], stats: ["first_heard", "last_heard"], of: "site_id" },
  talkgroup: { table: "talkgroups", key: "id", prefix: "tg", fields: ["system_id", "number", "alpha", "description", "mode", "tag", "category", "priority", "status", "merged_into"], stats: ["first_heard", "last_heard", "grants", "encrypted"], of: "system_id" },
  license: { table: "fcc_licenses", key: "id", prefix: "lic", fields: ["system_id", "freq_hz", "call_sign", "name", "source"], stats: [], of: "system_id" },
  claim: { table: "claims", key: "id", prefix: "cl", fields: ["key", "record_kind", "record_id"], stats: ["observations", "first_seen", "last_seen"], of: "record_id" },
  redirect: { table: "redirects", key: "id", prefix: null, fields: ["new_id"], stats: [], of: "new_id" },
  candidate: { table: "candidates", key: "id", prefix: "cand", fields: ["record_id", "field", "value"], stats: [], of: "record_id" },
  supporter: { table: "supporters", key: "id", prefix: "sup", fields: ["candidate_id", "actor", "at", "weight", "void"], stats: [], of: "candidate_id" },
  lock: { table: "locks", key: "id", prefix: "lock", fields: ["record_id", "field", "value", "by", "at", "reason"], stats: [], of: "record_id" },
};

export type KindName = keyof typeof KINDS;

/** An ID's kind, by its prefix. */
export const PREFIX_KIND: Record<string, KindName> = Object.fromEntries(
  Object.entries(KINDS).filter(([, t]) => t.prefix).map(([k, t]) => [t.prefix!, k]),
);

export interface ChangeSetInfo {
  actorKind: "recorder" | "contributor" | "steward" | "admin" | "system";
  actorId: string;
  kind: "share" | "edit" | "merge" | "split" | "revert" | "lock" | "hide" | "retire" | "unquarantine";
  observationId?: string;
  revertsId?: string;
  note?: string;
}

interface Revision {
  kind: string;
  id: string;
  field: string;
  before: unknown;
  after: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class ChangeSet {
  readonly id = newId("cs");
  readonly at: number;
  /** kind:id → the row now (null: removed). */
  private rows = new Map<string, Row | null>();
  /** kind:id of rows as they were in the database (to know insert vs update). */
  private stored = new Map<string, Row | null>();
  readonly revisions: Revision[] = [];
  private stats: Stmt[] = [];
  /** Systems whose version this change set makes. */
  readonly systems = new Set<string>();

  readonly db: Db;
  readonly info: ChangeSetInfo;

  constructor(db: Db, info: ChangeSetInfo, at = Date.now()) {
    this.db = db;
    this.info = info;
    this.at = at;
  }

  private k = (kind: string, id: string) => `${kind}:${id}`;

  /** A record as it is now (its own changes in), or null. */
  async get(kind: KindName, id: string): Promise<Row | null> {
    const key = this.k(kind, id);
    if (this.rows.has(key)) return this.rows.get(key) ?? null;
    const t = KINDS[kind];
    const r = (await this.db.all(`SELECT * FROM ${t.table} WHERE ${t.key} = ?`, [id]))[0] ?? null;
    this.stored.set(key, r);
    this.rows.set(key, r ? { ...r } : null);
    return this.rows.get(key) ?? null;
  }

  /**
   * Records of `kind` matching `where` (SQL) as they are now: the database's,
   * with this change set's changes in, and its new ones that `pred` (the same
   * test, in code) takes.
   */
  async query(kind: KindName, where: string, params: unknown[], pred: (r: Row) => boolean): Promise<Row[]> {
    const t = KINDS[kind];
    const fromDb = await this.db.all(`SELECT * FROM ${t.table} WHERE ${where}`, params);
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const r of fromDb) {
      const key = this.k(kind, r[t.key] as string);
      seen.add(key);
      if (!this.rows.has(key)) {
        this.stored.set(key, r);
        this.rows.set(key, { ...r });
      }
      const now = this.rows.get(key);
      if (now && pred(now)) out.push(now);
    }
    for (const [key, r] of this.rows) {
      if (!seen.has(key) && key.startsWith(`${kind}:`) && r && pred(r)) out.push(r);
    }
    return out;
  }

  /** The system a record (by its ID's kind) is of, or null. */
  async systemOf(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    const kind = PREFIX_KIND[id.slice(0, id.indexOf("_"))];
    if (!kind) return null;
    if (kind === "system") return id;
    const r = await this.get(kind, id);
    return r ? this.systemOf(r[KINDS[kind].of] as string) : null;
  }

  /** Take rows read from the database (in bulk) as this change set's to work on. Returns them as they are now. */
  adopt(kind: KindName, rows: Row[]): Row[] {
    const t = KINDS[kind];
    return rows.flatMap((r) => {
      const key = this.k(kind, r[t.key] as string);
      if (!this.rows.has(key)) {
        this.stored.set(key, r);
        this.rows.set(key, { ...r });
      }
      const now = this.rows.get(key);
      return now ? [now] : [];
    });
  }

  private async touch(kind: KindName, r: Row) {
    const t = KINDS[kind];
    const sys = await this.systemOf(t.of === t.key ? (r[t.key] as string) : (r[t.of] as string));
    if (sys) this.systems.add(sys);
  }

  /** A new record (its ID made if it has none); every field a revision ('*'). */
  async create(kind: KindName, row: Row): Promise<Row> {
    const t = KINDS[kind];
    const id = (row[t.key] as string) ?? newId(t.prefix!);
    const r = { ...row, [t.key]: id };
    const key = this.k(kind, id);
    if (!this.stored.has(key)) this.stored.set(key, null);
    this.rows.set(key, r);
    this.revisions.push({ kind, id, field: "*", before: null, after: r });
    await this.touch(kind, r);
    return r;
  }

  /** Change one field (a revision, if it changes). */
  async set(kind: KindName, id: string, field: string, value: unknown): Promise<void> {
    const t = KINDS[kind];
    if (!t.fields.includes(field)) throw new Error(`${kind}.${field} isn't a revisioned field`);
    const r = await this.get(kind, id);
    if (!r) throw new Error(`no ${kind} ${id}`);
    if (same(r[field], value)) return;
    // (Both systems' versions, when it moves from one to another.)
    await this.touch(kind, r);
    this.revisions.push({ kind, id, field, before: r[field] ?? null, after: value ?? null });
    r[field] = value;
    await this.touch(kind, r);
  }

  /** Remove a record (a revision '*' to null). Used by revert; everything else retires or merges. */
  async remove(kind: KindName, id: string): Promise<void> {
    const r = await this.get(kind, id);
    if (!r) return;
    await this.touch(kind, r);
    this.revisions.push({ kind, id, field: "*", before: r, after: null });
    this.rows.set(this.k(kind, id), null);
  }

  /** Put a removed record back as it was. */
  async restore(kind: KindName, row: Row): Promise<void> {
    const t = KINDS[kind];
    const id = row[t.key] as string;
    if (await this.get(kind, id)) return;
    this.rows.set(this.k(kind, id), { ...row });
    this.revisions.push({ kind, id, field: "*", before: null, after: row });
    await this.touch(kind, row);
  }

  /** Change evidence counters (no revision): `values` are set; `add` are added to. */
  async stat(kind: KindName, id: string, values: Row, add: Row = {}): Promise<void> {
    const r = await this.get(kind, id);
    if (!r) return;
    for (const [f, v] of Object.entries(values)) r[f] = v;
    for (const [f, v] of Object.entries(add)) r[f] = ((r[f] as number) ?? 0) + (v as number);
  }

  /** Statements to run with the commit (evidence tables that aren't records). */
  raw(...stmts: Stmt[]): void {
    this.stats.push(...stmts);
  }

  /** Mark a system's version as made by this change set, without a revision (evidence only). */
  bump(systemId: string): void {
    this.systems.add(systemId);
  }

  get empty(): boolean {
    return !this.revisions.length;
  }

  /** Write it all, in one batch. The new version of each system it changed. */
  async commit(): Promise<Map<string, number>> {
    const stmts: Stmt[] = [];
    const revisioned = !this.empty;
    if (revisioned) {
      const i = this.info;
      stmts.push({
        sql: "INSERT INTO changesets (id, at, actor_kind, actor_id, kind, observation_id, reverts_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params: [this.id, this.at, i.actorKind, i.actorId, i.kind, i.observationId ?? null, i.revertsId ?? null, i.note ?? ""],
      });
    }
    // New rows, as multi-row INSERTs by table and column set.
    const inserts = new Map<string, { table: string; cols: string[]; rows: unknown[][] }>();
    for (const [key, now] of this.rows) {
      const [kind, ...rest] = key.split(":");
      const id = rest.join(":");
      const t = KINDS[kind];
      const was = this.stored.get(key) ?? null;
      if (!now && was) stmts.push({ sql: `DELETE FROM ${t.table} WHERE ${t.key} = ?`, params: [id] });
      else if (now && !was) {
        const cols = Object.keys(now).sort();
        const g = `${t.table}(${cols.join(",")})`;
        const e = inserts.get(g) ?? { table: t.table, cols, rows: [] };
        e.rows.push(cols.map((c) => now[c] ?? null));
        inserts.set(g, e);
      } else if (now && was) {
        const cols = Object.keys(now).filter((c) => c !== t.key && !same(now[c], was[c]));
        if (cols.length) stmts.push({ sql: `UPDATE ${t.table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${t.key} = ?`, params: [...cols.map((c) => now[c] ?? null), id] });
      }
    }
    for (const e of inserts.values()) stmts.push(...insertRows(e.table, e.cols, e.rows));
    stmts.push(
      ...insertRows(
        "revisions",
        ["changeset_id", "record_kind", "record_id", "field", "before", "after"],
        this.revisions.map((r) => [this.id, r.kind, r.id, r.field, r.before === null ? null : JSON.stringify(r.before), r.after === null ? null : JSON.stringify(r.after)]),
      ),
    );
    stmts.push(...this.stats);
    // A new version of each system it changed (atomically, in the batch).
    const changed = revisioned ? [...this.systems] : [];
    for (const s of changed) {
      stmts.push({ sql: "INSERT INTO system_revs (system_id, rev, changeset_id) SELECT id, rev + 1, ? FROM systems WHERE id = ?", params: [this.id, s] });
      stmts.push({ sql: "UPDATE systems SET rev = rev + 1, updated_at = ? WHERE id = ?", params: [this.at, s] });
    }
    await this.db.batch(stmts);
    const revs = new Map<string, number>();
    if (changed.length) {
      const got = await this.db.all<{ system_id: string; rev: number }>(`SELECT system_id, rev FROM system_revs WHERE changeset_id = ?`, [this.id]);
      for (const g of got) revs.set(g.system_id, g.rev);
    }
    return revs;
  }
}
