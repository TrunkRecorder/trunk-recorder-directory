// Undoing changes (docs/design.md, "Reverting"). A revert is a new change set
// that puts each field back — if nothing changed it since; a field changed
// again since is a conflict, left as it is and reported. A revert is a change
// set like any other, so it can be reverted too. Merges revert the same way:
// both systems come back with their IDs, and their redirects go.

import type { Db } from "./db.ts";
import { reindex } from "./share.ts";
import { ChangeSet, type ChangeSetInfo, type KindName } from "./store.ts";

interface Rev {
  seq: number;
  changeset_id: string;
  record_kind: KindName;
  record_id: string;
  field: string;
  before: string | null;
  after: string | null;
}

export interface Conflict {
  kind: string;
  id: string;
  field: string;
  why: string;
}

export interface RevertResult {
  changesetId: string | null;
  reverted: number;
  conflicts: Conflict[];
  systems: Record<string, number>;
}

const json = (s: string | null) => (s === null ? null : JSON.parse(s));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Undo `revisions` (newest first), as one change set. Changes since them in
 * change sets other than `undoing` make conflicts.
 */
async function undo(db: Db, revisions: Rev[], undoing: Set<string>, info: ChangeSetInfo): Promise<RevertResult> {
  const cs = new ChangeSet(db, info);
  const conflicts: Conflict[] = [];
  let reverted = 0;
  const later = async (r: Rev, field: string | null) => {
    const rows = await db.all<{ changeset_id: string }>(
      `SELECT changeset_id FROM revisions WHERE record_id = ? AND seq > ? ${field ? "AND (field = ? OR field = '*')" : ""}`,
      field ? [r.record_id, r.seq, field] : [r.record_id, r.seq],
    );
    return rows.some((x) => !undoing.has(x.changeset_id));
  };
  for (const r of [...revisions].sort((a, b) => b.seq - a.seq)) {
    const before = json(r.before);
    const after = json(r.after);
    if (r.field === "*") {
      if (before === null) {
        // Made then: removed, if it hasn't changed since.
        if (await later(r, null)) conflicts.push({ kind: r.record_kind, id: r.record_id, field: "*", why: "changed since it was made" });
        else {
          await cs.remove(r.record_kind, r.record_id);
          reverted++;
        }
      } else if (after === null) {
        await cs.restore(r.record_kind, before);
        reverted++;
      }
      continue;
    }
    const row = await cs.get(r.record_kind, r.record_id);
    if (!row) {
      conflicts.push({ kind: r.record_kind, id: r.record_id, field: r.field, why: "it's gone" });
      continue;
    }
    if (!same(row[r.field], after) && (await later(r, r.field))) {
      conflicts.push({ kind: r.record_kind, id: r.record_id, field: r.field, why: "changed again since" });
      continue;
    }
    await cs.set(r.record_kind, r.record_id, r.field, before);
    reverted++;
  }
  if (cs.empty) return { changesetId: null, reverted, conflicts, systems: {} };
  if (conflicts.length) info.note = `${info.note ?? ""}${info.note ? " · " : ""}${conflicts.length} change(s) left: changed since`;
  const revs = await cs.commit();
  for (const s of revs.keys()) await reindex(db, s);
  return { changesetId: cs.id, reverted, conflicts, systems: Object.fromEntries(revs) };
}

/** Revert one change set. */
export async function revertChangeset(db: Db, id: string, actor: Omit<ChangeSetInfo, "kind" | "revertsId">): Promise<RevertResult> {
  const cs = (await db.all("SELECT id FROM changesets WHERE id = ?", [id]))[0];
  if (!cs) throw new Error("no such change set");
  const revisions = await db.all<Rev>("SELECT * FROM revisions WHERE changeset_id = ? ORDER BY seq", [id]);
  const res = await undo(db, revisions, new Set([id]), { ...actor, kind: "revert", revertsId: id, note: actor.note ?? "" });
  await db.batch([{ sql: "UPDATE observations SET status = 'reverted' WHERE changeset_id = ?", params: [id] }]);
  return res;
}

/** Put a system back as it was at version `rev`: every change set since, undone as one. */
export async function revertSystemTo(db: Db, systemId: string, rev: number, actor: Omit<ChangeSetInfo, "kind" | "revertsId">): Promise<RevertResult> {
  const sets = await db.all<{ changeset_id: string }>("SELECT changeset_id FROM system_revs WHERE system_id = ? AND rev > ? ORDER BY rev DESC", [systemId, rev]);
  if (!sets.length) return { changesetId: null, reverted: 0, conflicts: [], systems: {} };
  const ids = sets.map((s) => s.changeset_id);
  const revisions: Rev[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const some = ids.slice(i, i + 90);
    revisions.push(...(await db.all<Rev>(`SELECT * FROM revisions WHERE changeset_id IN (${some.map(() => "?").join(", ")})`, some)));
  }
  return undo(db, revisions, new Set(ids), { ...actor, kind: "revert", note: actor.note || `back to version ${rev}` });
}

/** Undo everything one recorder or account did (vandalism), newest first. */
export async function revertActor(db: Db, actorId: string, actor: Omit<ChangeSetInfo, "kind" | "revertsId">): Promise<RevertResult> {
  const ids = (await db.all<{ id: string }>("SELECT id FROM changesets WHERE actor_id = ? AND kind != 'revert' ORDER BY at DESC", [actorId])).map((r) => r.id);
  const revisions: Rev[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const some = ids.slice(i, i + 90);
    revisions.push(...(await db.all<Rev>(`SELECT * FROM revisions WHERE changeset_id IN (${some.map(() => "?").join(", ")})`, some)));
  }
  return undo(db, revisions, new Set(ids), { ...actor, kind: "revert", note: actor.note || `everything ${actorId} did` });
}
