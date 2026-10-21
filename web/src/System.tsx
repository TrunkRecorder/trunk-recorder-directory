// A system: its sites (heard, and announced by neighbours), talkgroups (with
// the other names people gave), licenses, and history; any version of it; and
// adding it to Trunk Recorder Pro.

import { useEffect, useMemo, useState } from "react";
import { ago, get, hex, mhz, NotFound, TYPE, API, type HistoryEntry, type SystemView, type TalkgroupView } from "./api.ts";
import { go, Link } from "./router.tsx";

type Tab = "sites" | "talkgroups" | "licenses" | "history";

export function SystemPage(props: { id: string; tab: Tab; query: URLSearchParams }) {
  const rev = props.query.get("rev");
  const [sys, setSys] = useState<SystemView | null>(null);
  const [tgs, setTgs] = useState<TalkgroupView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const at = rev ? `?rev=${rev}` : "";

  useEffect(() => {
    setError(null);
    setSys(null);
    setTgs(null);
    get<SystemView>(`/systems/${props.id}${at}`).then(
      // Merged into another: its page.
      (s) => (s.id !== props.id ? go(`/systems/${s.id}${props.tab === "sites" ? "" : `/${props.tab}`}`, true) : setSys(s)),
      (e) => setError(e instanceof NotFound ? "There's no such system." : String(e.message ?? e)),
    );
    get<{ talkgroups: TalkgroupView[] }>(`/systems/${props.id}/talkgroups${at}`).then((r) => r.talkgroups && setTgs(r.talkgroups), () => {});
  }, [props.id, rev]);

  if (error) return <div className="banner bad">{error}</div>;
  if (!sys) return <p className="muted">Loading…</p>;
  const heard = sys.sites.filter((s) => s.status === "heard").length;
  const tab = (t: Tab, label: string) => (
    <Link to={`/systems/${sys.id}${t === "sites" ? "" : `/${t}`}${at}`} className={`tab${props.tab === t ? " on" : ""}`}>
      {label}
    </Link>
  );
  return (
    <div className="stack">
      <section className="stack">
        <div className="row">
          <h1>{sys.name || "Unnamed system"}</h1>
          <span className="spacer" />
          <button className="btn primary" onClick={() => setAdding(true)}>
            Add to Trunk Recorder Pro
          </button>
        </div>
        <div className="kv muted">
          <span>{TYPE[sys.type] ?? sys.type}</span>
          {sys.wacn != null && (
            <span>
              WACN <b className="mono">{hex(sys.wacn)}</b> · System ID <b className="mono">{hex(sys.sysId)}</b>
            </span>
          )}
          <span>
            {heard} site{heard === 1 ? "" : "s"} heard
            {sys.sites.length > heard ? `, ${sys.sites.length - heard} announced` : ""}
          </span>
          <span>{sys.talkgroupCount} talkgroups</span>
          <span>
            version {sys.rev} · updated {ago(sys.updatedAt)}
          </span>
        </div>
        {rev && (
          <div className="banner">
            <span>
              This is version {rev}, as it was. <Link to={`/systems/${sys.id}${props.tab === "sites" ? "" : `/${props.tab}`}`}>See it now</Link>
            </span>
          </div>
        )}
      </section>
      <nav className="tabs">
        {tab("sites", `Sites (${sys.sites.length})`)}
        {tab("talkgroups", `Talkgroups (${sys.talkgroupCount})`)}
        {tab("licenses", `Licenses (${Object.keys(sys.licenses).length})`)}
        {tab("history", "History")}
      </nav>
      {props.tab === "sites" && <Sites sys={sys} />}
      {props.tab === "talkgroups" && <Talkgroups sys={sys} tgs={tgs} initial={props.query.get("q") ?? ""} />}
      {props.tab === "licenses" && <Licenses sys={sys} />}
      {props.tab === "history" && <History sys={sys} />}
      {adding && <AddDialog sys={sys} onClose={() => setAdding(false)} />}
    </div>
  );
}

function Sites(props: { sys: SystemView }) {
  const name = (id: string) => {
    const s = props.sys.sites.find((x) => x.id === id);
    return s ? (s.rfss != null ? `${s.rfss}-${s.site}` : s.name || id) : id;
  };
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th>Control channels</th>
            <th>Voice</th>
            <th>NAC</th>
            <th>Heard</th>
            <th>Neighbours</th>
          </tr>
        </thead>
        <tbody>
          {props.sys.sites.map((s) => (
            <tr key={s.id} className={s.status === "announced" ? "dim" : ""}>
              <td>
                <b>{s.rfss != null ? `${s.rfss}-${s.site}` : "—"}</b> {s.name && <span className="muted">{s.name}</span>}
                {s.status === "announced" && <span className="tag" title="A neighbouring site's control channel announces it; no one has shared it yet">announced</span>}
              </td>
              <td className="mono">{s.controlChannelsHz.map(mhz).join(", ")}</td>
              <td className="muted">{s.voiceChannelsHz.length || "—"}</td>
              <td className="mono">{hex(s.nac)}</td>
              <td className="muted small">
                {s.status === "heard" ? `${ago(s.lastHeard)}${s.heardCells ? ` · from ${s.heardCells} place${s.heardCells === 1 ? "" : "s"}` : ""}` : "not yet"}
              </td>
              <td className="muted small">{s.neighbours.map(name).join(", ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Talkgroups(props: { sys: SystemView; tgs: TalkgroupView[] | null; initial: string }) {
  const [filter, setFilter] = useState(props.initial);
  const [heardOnly, setHeardOnly] = useState(false);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const month = Date.now() - 30 * 86400_000;
    return (props.tgs ?? []).filter(
      (t) => (!f || String(t.number) === f || [t.alpha, t.description, t.tag, t.category].some((x) => x.toLowerCase().includes(f))) && (!heardOnly || (t.lastHeard ?? 0) > month),
    );
  }, [props.tgs, filter, heardOnly]);
  if (!props.tgs) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <div className="row">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter: number, name, tag, category" aria-label="Filter talkgroups" />
        <label className="toggle small">
          <input type="checkbox" checked={heardOnly} onChange={(e) => setHeardOnly(e.target.checked)} /> Heard in the last 30 days
        </label>
        <span className="spacer" />
        <a className="btn" href={`${API}/systems/${props.sys.id}/talkgroups.csv`} download={`${props.sys.id}-talkgroups.csv`}>
          Download CSV
        </a>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>TG</th>
              <th>Name</th>
              <th>Description</th>
              <th>Tag</th>
              <th>Category</th>
              <th>Heard</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.id} className={t.status === "heard" ? "dim" : ""}>
                <td className="mono">{t.number}</td>
                <td>
                  {t.alpha || <span className="muted">not named yet</span>}
                  {t.encrypted && <span className="tag" title="Heard encrypted">enc</span>}
                  {t.alternatives?.some((a) => a.field === "alpha") && (
                    <span className="tag alt" title={`Also called: ${t.alternatives.filter((a) => a.field === "alpha").map((a) => `${a.value} (${a.supporters})`).join(", ")}`}>
                      {`${1 + t.alternatives.filter((a) => a.field === "alpha").length} names`}
                    </span>
                  )}
                </td>
                <td className="muted">{t.description}</td>
                <td>{t.tag}</td>
                <td className="muted">{t.category}</td>
                <td className="muted small">
                  {t.lastHeard ? `${ago(t.lastHeard)} · ${t.sites.length} site${t.sites.length === 1 ? "" : "s"}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Licenses(props: { sys: SystemView }) {
  const rows = Object.entries(props.sys.licenses).sort(([a], [b]) => Number(a) - Number(b));
  if (!rows.length) return <p className="muted">No licenses known yet. Motorola P25 sites say their call signs on the air; Trunk Recorder Pro's Identify looks them up.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>MHz</th>
            <th>Call sign</th>
            <th>Licensee</th>
            <th>From</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, l]) => (
            <tr key={k}>
              <td className="mono">{mhz(Number(k))}</td>
              <td className="mono">{l.callSign}</td>
              <td>{l.name || <span className="muted">—</span>}</td>
              <td className="muted small">{{ air: "heard on the air", lookup: "FCC lookup", user: "a user" }[l.source] ?? l.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const NOUN: Record<string, [string, string]> = {
  system: ["system", "systems"], site: ["site", "sites"], freq: ["frequency", "frequencies"], neighbour: ["neighbour link", "neighbour links"],
  talkgroup: ["talkgroup", "talkgroups"], license: ["license", "licenses"], redirect: ["redirect", "redirects"], lock: ["lock", "locks"],
};
const noun = (k: string, n: number) => (NOUN[k] ?? [k, `${k}s`])[n === 1 ? 0 : 1];

const KIND_WORD: Record<string, string> = { share: "Shared", merge: "Merged", revert: "Reverted", lock: "Locked", edit: "Edited", hide: "Hidden", retire: "Retired", split: "Split" };

function History(props: { sys: SystemView }) {
  const [h, setH] = useState<HistoryEntry[] | null>(null);
  useEffect(() => {
    get<{ history: HistoryEntry[] }>(`/systems/${props.sys.id}/history`).then((r) => setH(r.history), () => setH([]));
  }, [props.sys.id]);
  if (!h) return <p className="muted">Loading…</p>;
  return (
    <ul className="history">
      {h.map((e) => (
        <li key={e.rev} className="card">
          <div className="row">
            <b>Version {e.rev}</b>
            <span className="muted small">
              {KIND_WORD[e.kind] ?? e.kind} by {e.actor} · {new Date(e.at).toLocaleString()}
            </span>
            <span className="spacer" />
            <Link to={`/systems/${props.sys.id}?rev=${e.rev}`} className="small">
              View
            </Link>
            <Link to={`/changesets/${e.changesetId}`} className="small">
              Changes
            </Link>
          </div>
          <div className="muted small">
            {Object.entries(e.summary)
              .map(([k, v]) => [v.added && `${v.added} ${noun(k, v.added)} added`, v.changed && `${v.changed} ${noun(k, 1)} change${v.changed === 1 ? "" : "s"}`, v.removed && `${v.removed} ${noun(k, v.removed)} removed`].filter(Boolean).join(", "))
              .filter(Boolean)
              .join("; ") || "Evidence only"}
            {e.note && ` · ${e.note}`}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Adding it to TRP: the browser version on this site imports it; the desktop app fetches it from the link. */
function AddDialog(props: { sys: SystemView; onClose: () => void }) {
  const heard = props.sys.sites.filter((s) => s.status === "heard");
  const [sites, setSites] = useState<string[]>(heard.map((s) => s.id));
  const [desktop, setDesktop] = useState(() => {
    try {
      return localStorage.getItem("trp.directory.desktop") ?? "http://localhost:8080";
    } catch {
      return "http://localhost:8080";
    }
  });
  const q = sites.length && sites.length < props.sys.sites.length ? `?sites=${sites.join(",")}` : "";
  const open = () => {
    try {
      localStorage.setItem("trp.directory.desktop", desktop);
    } catch {
      /* remembered next time, if storage works */
    }
    window.open(`${desktop.replace(/\/+$/, "")}/#import=${props.sys.id}${q ? `&sites=${sites.join(",")}` : ""}`, "_blank");
  };
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Add to Trunk Recorder Pro" onClick={props.onClose} onKeyDown={(e) => e.key === "Escape" && props.onClose()} tabIndex={-1}>
      <div className="modal stack" onClick={(e) => e.stopPropagation()}>
        <h3>Add {props.sys.name || "this system"} to Trunk Recorder Pro</h3>
        {props.sys.sites.length > 1 && (
          <fieldset className="stack">
            <legend className="small muted">The sites you can receive (its talkgroups heard there come with them)</legend>
            {props.sys.sites.map((s) => (
              <label key={s.id} className="toggle small">
                <input type="checkbox" checked={sites.includes(s.id)} onChange={(e) => setSites(e.target.checked ? [...sites, s.id] : sites.filter((x) => x !== s.id))} />
                {s.rfss != null ? `${s.rfss}-${s.site}` : s.name} · {s.controlChannelsHz.map(mhz).join(", ")} MHz{s.status === "announced" ? " (announced)" : ""}
              </label>
            ))}
          </fieldset>
        )}
        <div className="stack">
          <b>Desktop app</b>
          <div className="row">
            <input value={desktop} onChange={(e) => setDesktop(e.target.value)} aria-label="Your Trunk Recorder Pro's address" />
            <button className="btn primary" onClick={open} disabled={!sites.length}>
              Open in Trunk Recorder Pro
            </button>
          </div>
          <span className="muted small">It shows what it will add before adding it.</span>
        </div>
        <div className="stack">
          <b>Or download</b>
          <div className="row">
            <a className="btn" href={`${API}/systems/${props.sys.id}/config${q}`} download={`${props.sys.id}.json`}>
              System (TRP config JSON)
            </a>
            <a className="btn" href={`${API}/systems/${props.sys.id}/talkgroups.csv${q}`} download={`${props.sys.id}-talkgroups.csv`}>
              Talkgroups (CSV)
            </a>
          </div>
        </div>
        <div className="row">
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
