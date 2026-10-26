// A system: its sites (heard, and announced by neighbours), talkgroups (with
// the other names people gave), licenses, and history; any version of it; and
// adding it to Trunk Recorder Pro; and the SDRs it takes (Sdrs.tsx). A system
// known only by its license (status "licensed": no one has shared it) is
// shown the same way, with what a license can't say left out: its sites are
// the license's stations with their frequencies, and it has no talkgroups or
// history; Trunk Recorder Pro's survey finds it by its licenses.

import { useEffect, useMemo, useState } from "react";
import { ago, get, hex, mhz, nameOf, NotFound, siteLabel, TYPE, API, type HistoryEntry, type SystemView, type TalkgroupView, type Where as WhereView } from "./api.ts";
import { KIND_LABEL } from "./filters.tsx";
import { go, Link } from "./router.tsx";
import { MapView } from "./MapView.tsx";
import { Dialog, Page } from "./Page.tsx";
import { SdrPlanner } from "./Sdrs.tsx";

type Tab = "sites" | "talkgroups" | "licenses" | "sdrs" | "history";

export function SystemPage(props: { id: string; tab: Tab; query: URLSearchParams }) {
  const rev = props.query.get("rev");
  const [sys, setSys] = useState<SystemView | null>(null);
  const [tgs, setTgs] = useState<TalkgroupView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [where, setWhere] = useState<WhereView | null>(null);
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
    setWhere(null);
    get<WhereView>(`/systems/${props.id}/where`).then(setWhere, () => setWhere({ transmitters: [], placements: [] }));
  }, [props.id, rev]);

  if (error) return <div className="banner bad">{error}</div>;
  if (!sys) return <p className="muted">Loading…</p>;
  const licensed = sys.status === "licensed";
  const heard = sys.sites.filter((s) => s.status === "heard").length;
  const callSigns = [...new Set(Object.values(sys.licenses).map((l) => l.callSign))];
  const tab = (t: Tab, label: string) => (
    <Link to={`/systems/${sys.id}${t === "sites" ? "" : `/${t}`}${at}`} className={`tab${props.tab === t ? " on" : ""}`}>
      {label}
    </Link>
  );
  const title = nameOf(sys);
  return (
    <Page
      title={title}
      label={title}
      self={`/systems/${sys.id}`}
      fallback={[{ label: "Map", to: licensed ? `/?licensed=1&at=${sys.lat},${sys.lon}&z=10` : `/?sel=${sys.id}` }]}
      actions={
        <button className="btn primary" onClick={() => setAdding(true)}>
          Add to Trunk Recorder Pro
        </button>
      }
      meta={
        licensed ? (
          <>
            <span className="kind-badge" data-kind={sys.type}>
              {KIND_LABEL[sys.type]}
            </span>
            <span className="mono">{callSigns.join(", ")}</span>
            <span>
              {sys.sites.length} licensed site{sys.sites.length === 1 ? "" : "s"} · {Object.keys(sys.licenses).length} frequencies
            </span>
          </>
        ) : (
        <>
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
        </>
        )
      }
    >
      {rev && (
        <div className="banner">
          <span>
            This is version {rev}, as it was. <Link to={`/systems/${sys.id}${props.tab === "sites" ? "" : `/${props.tab}`}`}>See it now</Link>
          </span>
        </div>
      )}
      {licensed && (
        <div className="banner">
          Licensed, but no one has shared it yet: this is what its FCC license says. Which frequency is its control channel, its identity and its talkgroups come from the air: add it to Trunk Recorder Pro, and its survey looks for it.
        </div>
      )}
      <nav className="tabs">
        {tab("sites", `Sites (${sys.sites.length})`)}
        {!licensed && tab("talkgroups", `Talkgroups (${sys.talkgroupCount})`)}
        {tab("licenses", `Licenses (${Object.keys(sys.licenses).length})`)}
        {tab("sdrs", "SDRs needed")}
        {!licensed && tab("history", "History")}
      </nav>
      {props.tab === "sites" && where && <Where sys={sys} w={where} />}
      {props.tab === "sites" && <Sites sys={sys} />}
      {props.tab === "talkgroups" && <Talkgroups sys={sys} tgs={tgs} initial={props.query.get("q") ?? ""} />}
      {props.tab === "licenses" && <Licenses sys={sys} />}
      {props.tab === "sdrs" && <SdrPlanner sys={sys} />}
      {props.tab === "history" && <History sys={sys} />}
      {adding && <AddDialog sys={sys} onClose={() => setAdding(false)} />}
    </Page>
  );
}

/** Where it is: its sites' licensed transmitters on a map, and the counties and cities they're in. */
function Where(props: { sys: SystemView; w: WhereView }) {
  const w = props.w;
  const layers = useMemo(() => ({
    sites: { type: "FeatureCollection" as const, features: w.transmitters.map((t) => ({ type: "Feature" as const, properties: { system: props.sys.id, name: props.sys.name, type: props.sys.type, stale: false }, geometry: { type: "Point" as const, coordinates: [t.lon, t.lat] } })) },
  }), [w]);
  if (!w.transmitters.length) {
    const why = w.placements.find((p) => p.note)?.note;
    return <p className="muted small">Not on the map yet: no FCC license matched its frequencies{why ? ` (${why})` : ""}.</p>;
  }
  const lat = w.transmitters.reduce((a, t) => a + t.lat, 0) / w.transmitters.length;
  const lon = w.transmitters.reduce((a, t) => a + t.lon, 0) / w.transmitters.length;
  const spread = Math.max(...w.transmitters.map((t) => Math.max(Math.abs(t.lat - lat), Math.abs(t.lon - lon))));
  const zoom = spread > 1 ? 7 : spread > 0.3 ? 8.5 : spread > 0.1 ? 10 : 11;
  const counties = new Map<string, { state: string; name: string; cities: Map<string, string> }>();
  for (const t of w.transmitters) {
    if (!t.county) continue;
    const c = counties.get(t.county) ?? { state: t.state, name: t.countyName || t.county, cities: new Map() };
    if (t.place) c.cities.set(t.place, t.placeName || t.place);
    counties.set(t.county, c);
  }
  const licensees = [...new Set(w.transmitters.map((t) => t.licensee).filter(Boolean))];
  return (
    <section className="where">
      <MapView className="where-map" label={`Map of ${props.sys.name || "this system"}'s transmitters`} view={{ center: [lat, lon], zoom }} layers={layers} />
      <div className="stack small">
        <div>
          <b>{w.transmitters.length}</b> licensed transmitter{w.transmitters.length === 1 ? "" : "s"}
          {licensees.length > 0 && <span className="muted"> · {licensees.join(", ")}</span>}
        </div>
        <div className="kv">
          {[...counties].map(([geoid, c]) => (
            <span key={geoid}>
              <Link to={`/browse/${c.state}/${geoid}`}>{c.name}</Link>
              <span className="muted">, {c.state}</span>
              {c.cities.size > 0 && (
                <span className="muted">
                  {" "}
                  ({[...c.cities].map(([g, n], i) => (
                    <span key={g}>
                      {i > 0 && ", "}
                      <Link to={`/browse/${c.state}/${geoid}/${g}`}>{n}</Link>
                    </span>
                  ))})
                </span>
              )}
            </span>
          ))}
        </div>
        <p className="muted">{props.sys.status === "licensed" ? "From its FCC license: its base and repeater stations." : "Placed from its FCC licenses: the base and repeater stations licensed on its frequencies."}</p>
      </div>
    </section>
  );
}

function Sites(props: { sys: SystemView }) {
  const name = (id: string) => {
    const s = props.sys.sites.find((x) => x.id === id);
    return s ? siteLabel(s) : id;
  };
  if (props.sys.status === "licensed")
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>Licensed frequencies (MHz)</th>
            </tr>
          </thead>
          <tbody>
            {props.sys.sites.map((s) => (
              <tr key={s.id}>
                <td>
                  <b>{siteLabel(s)}</b>
                </td>
                <td className="mono small">{s.licensedHz.map(mhz).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
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
                {s.status === "heard" ? ago(s.lastHeard) : "not yet"}
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
/** Trunk Recorder Pro for the web (the landing site's /app). */
const WEB_APP = "https://trunkrecorder.pro/app";

function AddDialog(props: { sys: SystemView; onClose: () => void }) {
  const licensed = props.sys.status === "licensed";
  // The sites offered at first: those heard (a licensed system's: all).
  const [sites, setSites] = useState<string[]>(props.sys.sites.filter((s) => licensed || s.status === "heard").map((s) => s.id));
  const [desktop, setDesktop] = useState(() => {
    try {
      return localStorage.getItem("trp.directory.desktop") ?? "http://localhost:8080";
    } catch {
      return "http://localhost:8080";
    }
  });
  const q = sites.length && sites.length < props.sys.sites.length ? `?sites=${sites.join(",")}` : "";
  // The bundle (trp-system: its config, named talkgroups, where it came from): what Trunk Recorder Pro imports.
  const bundle = `${location.origin}${API}/systems/${props.sys.id}/config${q}`;
  const link = (app: string) => `${app.replace(/\/+$/, "")}/#import=${encodeURIComponent(bundle)}`;
  const openDesktop = () => {
    try {
      localStorage.setItem("trp.directory.desktop", desktop);
    } catch {
      /* remembered next time, if storage works */
    }
    window.open(link(desktop), "_blank");
  };
  return (
    <Dialog
      title={`Add ${nameOf(props.sys)} to Trunk Recorder Pro`}
      onClose={props.onClose}
      actions={
        <button className="btn" onClick={props.onClose}>
          Close
        </button>
      }
    >
      <p className="muted small">
        {licensed
          ? "No one has shared it, so what comes is its licenses: the frequencies licensed at the sites you choose. Trunk Recorder Pro's survey looks for it on them, and the control channel it finds sets the system up."
          : "Its sites, channels, licenses and named talkgroups. Trunk Recorder Pro shows what it will add first, and updates the system if you already have it."}
      </p>
      {props.sys.sites.length > 1 && (
        <fieldset className="stack">
          <legend className="small muted">The sites you can receive{licensed ? "" : " (its talkgroups heard there come with them)"}</legend>
          {props.sys.sites.map((s) => (
            <label key={s.id} className="toggle small">
              <input type="checkbox" checked={sites.includes(s.id)} onChange={(e) => setSites(e.target.checked ? [...sites, s.id] : sites.filter((x) => x !== s.id))} />
              {siteLabel(s)} · {licensed ? `${s.licensedHz.length} licensed frequencies` : `${s.controlChannelsHz.map(mhz).join(", ")} MHz`}
              {s.status === "announced" ? " (announced)" : ""}
            </label>
          ))}
        </fieldset>
      )}
      <div className="stack">
        <b>In your browser</b>
        <div className="row">
          <a className={`btn primary${sites.length ? "" : " disabled"}`} href={sites.length ? link(WEB_APP) : undefined} target="_blank" rel="noreferrer">
            Open in Trunk Recorder Pro for the web
          </a>
        </div>
        <span className="muted small">Records with an RTL-SDR plugged into this computer (Chrome or Edge).</span>
      </div>
      <div className="stack">
        <b>Desktop app</b>
        <div className="row">
          <input value={desktop} onChange={(e) => setDesktop(e.target.value)} aria-label="Your Trunk Recorder Pro's address" />
          <button className="btn" onClick={openDesktop} disabled={!sites.length}>
            Open in Trunk Recorder Pro
          </button>
        </div>
        <span className="muted small">Its address, as you open it in your browser.</span>
      </div>
      <div className="stack">
        <b>Or download it</b>
        <div className="row">
          <a className="btn" href={`${bundle}${q ? "&" : "?"}download=1`} download>
            Download for Trunk Recorder Pro
          </a>
          {!licensed && (
            <a className="btn ghost" href={`${API}/systems/${props.sys.id}/talkgroups.csv${q}`} download={`${props.sys.id}-talkgroups.csv`}>
              Talkgroups only (CSV)
            </a>
          )}
        </div>
        <span className="muted small">In Trunk Recorder Pro: Setup → Systems → Import… and choose the file.</span>
      </div>
    </Dialog>
  );
}
