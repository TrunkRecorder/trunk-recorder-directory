// One version's changes, field by field.

import { useEffect, useState } from "react";
import { get, NotFound } from "./api.ts";
import { Page } from "./Page.tsx";

interface Rev {
  record_kind: string;
  record_id: string;
  field: string;
  before: unknown;
  after: unknown;
}

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function ChangesetPage(props: { id: string }) {
  const [c, setC] = useState<{ info: Record<string, unknown>; revisions: Rev[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<{ info: Record<string, unknown>; revisions: Rev[] }>(`/changesets/${props.id}`).then(setC, (e) => setError(e instanceof NotFound ? "No such change set." : String(e)));
  }, [props.id]);
  if (error) return <div className="banner bad">{error}</div>;
  if (!c) return <p className="muted">Loading…</p>;
  const label = (r: Rev) => {
    if (r.field !== "*") return null;
    const x = (r.after ?? r.before) as Record<string, unknown>;
    return x?.alpha || x?.name || x?.number || x?.value || x?.call_sign || "";
  };
  const title = String(c.info.kind)[0].toUpperCase() + String(c.info.kind).slice(1);
  return (
    <Page
      title={title}
      label={title}
      self={`/changesets/${props.id}`}
      meta={
        <span>
          {new Date(c.info.at as number).toLocaleString()} · by {c.info.actor_kind === "recorder" ? "a recorder" : String(c.info.actor_kind)}
          {c.info.note ? ` · ${c.info.note}` : ""}
        </span>
      }
    >
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>What</th>
              <th>Field</th>
              <th>Was</th>
              <th>Is</th>
            </tr>
          </thead>
          <tbody>
            {c.revisions
              .filter((r) => r.record_kind !== "candidate")
              .map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.record_kind} <span className="muted small">{String(label(r) ?? "")}</span>
                  </td>
                  <td className="mono small">{r.field === "*" ? (r.before === null ? "added" : "removed") : r.field}</td>
                  <td className="muted">{r.field === "*" ? "" : show(r.before)}</td>
                  <td>{r.field === "*" ? "" : show(r.after)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
