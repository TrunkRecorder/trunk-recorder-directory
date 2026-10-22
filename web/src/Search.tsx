// Search by anything: a system's name, who holds its licenses, an FCC call
// sign, a frequency (857.9875), an identity (BEE00.3A9), or a place (a county
// or city, to browse it). Filtered by kind of system, like every view.

import { useEffect, useState } from "react";
import { get, type PlaceHit, type SearchHit } from "./api.ts";
import { TypeFilter, typesOf, typesParam, typesValue, withQuery } from "./filters.tsx";
import { go, Link } from "./router.tsx";

const KIND: Record<string, string> = { system: "System", site: "Site", talkgroup: "Talkgroup", frequency: "Frequency", license: "FCC license", identity: "Identity" };

export function SearchPage(props: { query: URLSearchParams }) {
  const q = props.query.get("q") ?? "";
  const types = typesOf(props.query);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [places, setPlaces] = useState<PlaceHit[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHits(null);
    setError(null);
    if (!q.trim()) return setHits([]);
    const t = typesParam(types);
    get<{ hits: SearchHit[]; places: PlaceHit[] }>(`/search?q=${encodeURIComponent(q)}${t ? `&${t}` : ""}`).then(
      (r) => {
        setHits(r.hits);
        setPlaces(r.places ?? []);
      },
      (e) => setError(String(e.message ?? e)),
    );
  }, [q, types.join(",")]);

  const browse = (p: PlaceHit) => withQuery(p.kind === "state" ? `/browse/${p.state}` : p.kind === "county" ? `/browse/${p.state}/${p.geoid}` : `/browse/${p.state}/${p.county}/${p.geoid}`, new URLSearchParams(), { types: typesValue(types) });
  // One line per system (its best hit), in the order found.
  const bySystem = new Map<string, SearchHit[]>();
  for (const h of hits ?? []) bySystem.set(h.systemId, [...(bySystem.get(h.systemId) ?? []), h]);

  return (
    <div className="stack">
      <h1>{q ? <>Search: “{q}”</> : "Search"}</h1>
      <p className="muted small">A system's name, who holds its licenses, an FCC call sign, a frequency (857.9875), an identity (BEE00.3A9), or a county or city.</p>
      <TypeFilter types={types} onChange={(t) => go(withQuery("/search", props.query, { types: typesValue(t) }), true)} />
      {error && <div className="banner bad">{error}</div>}
      {places.filter((p) => p.transmitters > 0 || p.kind !== "place").length > 0 && (
        <section className="stack">
          <h2>Places</h2>
          <ul className="place-list">
            {places.map((p) => (
              <li key={p.geoid}>
                {p.kind !== "place" || p.county ? <Link to={browse(p)}>{p.name}, {p.state}</Link> : <span>{p.name}, {p.state}</span>}
                <span className="muted small">{p.transmitters ? `${p.transmitters} transmitter${p.transmitters === 1 ? "" : "s"} shared` : "nothing shared yet"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {hits === null && !error && <p className="muted">Searching…</p>}
      {hits && q && (
        <section className="stack">
          <h2>Systems</h2>
          {!bySystem.size && <p className="muted">Nothing found.</p>}
          <ul className="cards">
            {[...bySystem].map(([id, hs]) => (
              <li key={id} className="card">
                <Link to={`/systems/${id}`} className="card-title">
                  {hs[0].systemName || "Unnamed system"}
                </Link>
                <div className="muted small">
                  {hs.slice(0, 3).map((h) => `${KIND[h.kind] ?? h.kind}: ${h.label}`).join(" · ")}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
