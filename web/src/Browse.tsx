// By place: states, then a state's counties, a county's cities (Census
// places), and the systems in each, by kind. A system is in every county and
// city one of its licensed transmitters is in; one in many of a state's
// counties is listed once as regional, not under each.

import { useEffect, useState } from "react";
import { ago, get, nameOf, NotFound, TYPE, type SystemSummary } from "./api.ts";
import { TypeBadge, TypeFilter, typesOf, typesParam, typesValue, withQuery } from "./filters.tsx";
import { go, Link } from "./router.tsx";

interface StateRow { state: string; name: string; systems: number; byType: Record<string, number> }
interface Count { geoid: string; name: string; systems: number }
interface StateView { state: string; name: string; systems: number; regional: SystemSummary[]; counties: Count[] }
interface CountyView { state: string; geoid: string; name: string; systems: SystemSummary[]; regional: SystemSummary[]; cities: Count[] }
interface CityView { state: string; county: string; countyName: string; geoid: string; name: string; systems: SystemSummary[]; regional: SystemSummary[] }

function useData<T>(path: string | null, deps: unknown[]): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setError(null);
    if (path) get<T>(path).then(setData, (e) => setError(e instanceof NotFound ? "There's no such place." : String(e.message ?? e)));
  }, deps);
  return { data, error };
}

function Systems(props: { systems: SystemSummary[]; empty: string }) {
  if (!props.systems.length) return <p className="muted">{props.empty}</p>;
  return (
    <ul className="cards">
      {props.systems.map((s) => (
        <li key={s.id} className="card">
          <div className="row">
            <Link to={`/systems/${s.id}`} className="card-title">
              {nameOf(s)}
            </Link>
            <TypeBadge type={s.type} />
          </div>
          <div className="kv muted small">
            {s.name && s.licensee && <span>{s.licensee}</span>}
            <span>
              {s.sites} site{s.sites === 1 ? "" : "s"}
            </span>
            <span>{s.talkgroupCount} talkgroups</span>
            <span className={s.stale ? "stale" : ""}>heard {ago(s.lastHeard)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Places(props: { rows: Count[]; to: (geoid: string) => string; what: string }) {
  if (!props.rows.length) return null;
  return (
    <ul className="place-list">
      {props.rows.map((r) => (
        <li key={r.geoid}>
          <Link to={props.to(r.geoid)}>{r.name}</Link>
          <span className="muted small">
            {r.systems} system{r.systems === 1 ? "" : "s"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function BrowsePage(props: { path: string; query: URLSearchParams }) {
  const [, st, county, place] = /^\/browse(?:\/([A-Z]{2})(?:\/(\d{5})(?:\/(\d{7}))?)?)?\/?$/.exec(props.path) ?? [];
  const types = typesOf(props.query);
  const t = typesParam(types);
  const qs = t ? `?${t}` : "";
  const keep = (path: string) => withQuery(path, new URLSearchParams(), { types: typesValue(types) });
  const api = place ? `/places/${st}/${county}/${place}${qs}` : county ? `/places/${st}/${county}${qs}` : st ? `/places/${st}${qs}` : `/places${qs}`;
  const { data, error } = useData<unknown>(api, [api]);

  const d = data as { name?: string; stateName?: string; countyName?: string } | null;
  const crumbs: [string, string][] = [["All states", keep("/browse")]];
  if (st) crumbs.push([(county ? d?.stateName : d?.name) ?? st, keep(`/browse/${st}`)]);
  if (county) crumbs.push([(place ? d?.countyName : d?.name) ?? "…", keep(`/browse/${st}/${county}`)]);
  if (place) crumbs.push([d?.name ?? "…", keep(`/browse/${st}/${county}/${place}`)]);

  let body: React.ReactNode = <p className="muted">Loading…</p>;
  if (error) body = <div className="banner bad">{error}</div>;
  else if (data && !st) {
    const r = data as { states: StateRow[]; unplaced: number };
    body = (
      <>
        {!r.states.length && <p className="muted">No shared system has been placed on the map yet.</p>}
        <ul className="place-list">
          {r.states.map((s) => (
            <li key={s.state}>
              <Link to={keep(`/browse/${s.state}`)}>{s.name}</Link>
              <span className="muted small">
                {s.systems} system{s.systems === 1 ? "" : "s"}
                {" · "}
                {Object.entries(s.byType).map(([k, n]) => `${n} ${TYPE[k] ?? k}`).join(", ")}
              </span>
            </li>
          ))}
        </ul>
        {r.unplaced > 0 && (
          <p className="muted small">
            {r.unplaced} more system{r.unplaced === 1 ? " isn't" : "s aren't"} on the map yet: no FCC license matched their frequencies. <Link to="/search">Search</Link> finds them.
          </p>
        )}
      </>
    );
  } else if (data && st && !county) {
    const r = data as StateView;
    body = (
      <>
        {r.regional.length > 0 && (
          <section className="stack">
            <h2>Regional and statewide</h2>
            <p className="muted small">In many of its counties: listed here, not under each.</p>
            <Systems systems={r.regional} empty="" />
          </section>
        )}
        <section className="stack">
          <h2>Counties</h2>
          {r.counties.length ? <Places rows={r.counties} to={(g) => keep(`/browse/${st}/${g}`)} what="county" /> : <p className="muted">None of its counties has a shared system yet.</p>}
        </section>
      </>
    );
  } else if (data && county && !place) {
    const r = data as CountyView;
    body = (
      <>
        <section className="stack">
          <h2>Systems</h2>
          <Systems systems={r.systems} empty={r.regional.length ? "Only regional systems so far." : "No shared system here yet."} />
        </section>
        {r.cities.length > 0 && (
          <section className="stack">
            <h2>Cities and towns</h2>
            <Places rows={r.cities} to={(g) => keep(`/browse/${st}/${county}/${g}`)} what="city" />
          </section>
        )}
        {r.regional.length > 0 && (
          <section className="stack">
            <h2>Regional systems here too</h2>
            <Systems systems={r.regional} empty="" />
          </section>
        )}
      </>
    );
  } else if (data && place) {
    const r = data as CityView;
    body = (
      <>
        <Systems systems={r.systems} empty={r.regional.length ? "Only regional systems so far." : "No shared system here yet."} />
        {r.regional.length > 0 && (
          <section className="stack">
            <h2>Regional systems here too</h2>
            <Systems systems={r.regional} empty="" />
          </section>
        )}
      </>
    );
  }

  return (
    <div className="stack">
      <nav className="crumbs small" aria-label="Where">
        {crumbs.map(([label, to], i) => (
          <span key={to}>
            {i > 0 && <span className="muted"> › </span>}
            {i === crumbs.length - 1 ? <b>{label}</b> : <Link to={to}>{label}</Link>}
          </span>
        ))}
      </nav>
      <h1>{st ? crumbs[crumbs.length - 1][0] : "Systems by place"}</h1>
      <TypeFilter types={types} onChange={(x) => go(withQuery(props.path, props.query, { types: typesValue(x) }), true)} />
      {body}
    </div>
  );
}
