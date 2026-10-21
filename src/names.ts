// What a person wrote (a talkgroup's name, a site's name, a tag) is an
// assertion: a candidate value, backed by its supporters. The value shown is
// the best-supported one; a challenger must lead by a margin to replace it,
// so names don't flip between two camps; a steward's lock beats everything.
// docs/design.md, "Choosing between names".
//
// A NameIndex holds a system's candidates, supporters and locks in memory for
// a change set (one read each), so a share of thousands of talkgroups doesn't
// make thousands of queries.

import { type Row, marks } from "./db.ts";
import type { ChangeSet, KindName } from "./store.ts";

/** How far a challenger must lead the value shown to replace it (supporters' weight). */
export const TEXT_MARGIN = 2;
/** Settings (mode, tag, category, priority) change on any lead. */
export const SETTING_MARGIN = 0.5;
/** Support halves in this long. */
export const HALF_LIFE_MS = 365 * 24 * 3600 * 1000;

export const TEXT_FIELDS = new Set(["alpha", "description", "name"]);

export class NameIndex {
  /** record id → field → candidates. */
  private cands = new Map<string, Map<string, Row[]>>();
  /** candidate id → supporters. */
  private sups = new Map<string, Row[]>();
  /** record id → field → locks. */
  private locks = new Map<string, Map<string, Row[]>>();
  private quarantined = new Set<string>();

  readonly cs: ChangeSet;

  private constructor(cs: ChangeSet) {
    this.cs = cs;
  }

  /** The names of these records (a system, its sites and talkgroups), read once. */
  static async load(cs: ChangeSet, recordIds: string[]): Promise<NameIndex> {
    const x = new NameIndex(cs);
    x.quarantined = new Set((await cs.db.all<{ actor: string }>("SELECT actor FROM quarantined")).map((r) => r.actor));
    for (let i = 0; i < recordIds.length; i += 90) {
      const ids = recordIds.slice(i, i + 90);
      const cands = cs.adopt("candidate", await cs.db.all(`SELECT * FROM candidates WHERE record_id IN (${marks(ids.length)})`, ids));
      for (const c of cands) x.addCand(c);
      const cids = cands.map((c) => c.id as string);
      for (let j = 0; j < cids.length; j += 90) {
        const some = cids.slice(j, j + 90);
        for (const s of cs.adopt("supporter", await cs.db.all(`SELECT * FROM supporters WHERE candidate_id IN (${marks(some.length)})`, some))) x.addSup(s);
      }
      for (const l of cs.adopt("lock", await cs.db.all(`SELECT * FROM locks WHERE record_id IN (${marks(ids.length)})`, ids))) x.addLock(l);
    }
    return x;
  }

  private addCand(c: Row) {
    const byField = this.cands.get(c.record_id as string) ?? new Map<string, Row[]>();
    this.cands.set(c.record_id as string, byField);
    byField.set(c.field as string, [...(byField.get(c.field as string) ?? []), c]);
  }
  private addSup(s: Row) {
    this.sups.set(s.candidate_id as string, [...(this.sups.get(s.candidate_id as string) ?? []), s]);
  }
  private addLock(l: Row) {
    const byField = this.locks.get(l.record_id as string) ?? new Map<string, Row[]>();
    this.locks.set(l.record_id as string, byField);
    byField.set(l.field as string, [...(byField.get(l.field as string) ?? []), l]);
  }

  candidates(id: string, field: string): Row[] {
    return this.cands.get(id)?.get(field) ?? [];
  }
  supporters(candId: string): Row[] {
    return this.sups.get(candId) ?? [];
  }

  /** A candidate's support now: its supporters' weights, halving each year, quarantined ones left out. */
  score(candId: string): number {
    let n = 0;
    for (const s of this.supporters(candId)) {
      if (s.void || this.quarantined.has(s.actor as string)) continue;
      n += (s.weight as number) * 0.5 ** ((this.cs.at - (s.at as number)) / HALF_LIFE_MS);
    }
    return n;
  }

  /**
   * `actor` says `field` of record `id` is `value`: its support goes to that
   * candidate (and leaves any other it backed for the field), and the value
   * shown is chosen again.
   */
  async assert(kind: KindName, id: string, field: string, value: string, actor: string, weight = 1): Promise<void> {
    const cs = this.cs;
    let cand = this.candidates(id, field).find((c) => c.value === value);
    if (!cand) {
      cand = await cs.create("candidate", { record_id: id, field, value });
      this.addCand(cand);
    }
    for (const c of this.candidates(id, field)) {
      if (c.id === cand.id) continue;
      for (const s of this.supporters(c.id as string)) if (s.actor === actor && !s.void) await cs.set("supporter", s.id as string, "void", 1);
    }
    const mine = this.supporters(cand.id as string).find((s) => s.actor === actor);
    if (!mine) this.addSup(await cs.create("supporter", { candidate_id: cand.id, actor, at: cs.at, weight, void: 0 }));
    else if (mine.void) await cs.set("supporter", mine.id as string, "void", 0);
    await this.choose(kind, id, field);
  }

  /** Set the field to its locked value, or to the best-supported candidate if it leads by the margin. */
  async choose(kind: KindName, id: string, field: string): Promise<void> {
    const cs = this.cs;
    const row = await cs.get(kind, id);
    if (!row) return;
    const locks = this.locks.get(id)?.get(field) ?? [];
    if (locks.length) {
      const lock = [...locks].sort((a, b) => (b.at as number) - (a.at as number))[0];
      await cs.set(kind, id, field, lock.value);
      return;
    }
    const scored = this.candidates(id, field).map((c) => ({ value: c.value as string, score: this.score(c.id as string) }));
    const current = String(row[field] ?? "");
    const best = scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || (a.value === current ? -1 : b.value === current ? 1 : 0))[0];
    if (!best || best.value === current) return;
    const curScore = scored.find((c) => c.value === current)?.score ?? 0;
    const margin = TEXT_FIELDS.has(field) ? TEXT_MARGIN : SETTING_MARGIN;
    // An empty field takes the first value anyone gives it.
    // (Support decays by the millisecond: a lead of exactly the margin counts.)
    if (!current || best.score >= curScore + margin - 1e-6) await cs.set(kind, id, field, best.value);
  }

  /** The candidates of a record's field, with their support (for pages). */
  view(id: string, field: string): { value: string; score: number; supporters: number }[] {
    return this.candidates(id, field)
      .map((c) => ({ value: c.value as string, score: Math.round(this.score(c.id as string) * 100) / 100, supporters: this.supporters(c.id as string).filter((s) => !s.void).length }))
      .sort((a, b) => b.score - a.score);
  }

  /** A lock, from now on. */
  async lock(kind: KindName, id: string, field: string, value: string, by: string, reason: string): Promise<void> {
    this.addLock(await this.cs.create("lock", { record_id: id, field, value, by, at: this.cs.at, reason }));
    await this.choose(kind, id, field);
  }
}
