// Finding systems: near a place (the browser's location, or coordinates), or
// by anything — a frequency, a call sign, an identity, a name. The search is
// kept in the URL, so it can be shared or bookmarked.

import { useEffect, useState } from "react";
import { get, ago, TYPE, type NearResult, type SearchHit } from "./api.ts";
import { go, Link } from "./router.tsx";

const RADII = [10, 25, 50, 100, 150];

/** "38.9072, -77.0369" (as a map copies it): a point, or null. */
const latLon = (s: string) => {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  return m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180 ? { lat: +m[1], lon: +m[2] } : null;
};

export function Home(props: { query: URLSearchParams }) {
  const q = props.query.get("q") ?? "";
  const at = latLon(props.query.get("at") ?? "");
  const radius = Number(props.query.get("radius")) || 50;
  const [text, setText] = useState(q || props.query.get("at") || "");
  const [near, setNear] = useState<NearResult[] | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    setError(null);
    setNear(null);
    setHits(null);
    if (at) get<{ systems: NearResult[] }>(`/systems?lat=${at.lat}&lon=${at.lon}&radiusKm=${radius}`).then((r) => setNear(r.systems), (e) => setError(String(e.message ?? e)));
    else if (q) get<{ hits: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`).then((r) => setHits(r.hits), (e) => setError(String(e.message ?? e)));
  }, [q, at?.lat, at?.lon, radius]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = latLon(text);
    go(p ? `/?at=${p.lat},${p.lon}&radius=${radius}` : text.trim() ? `/?q=${encodeURIComponent(text.trim())}` : "/");
  };
  const mine = () => {
    if (!("geolocation" in navigator)) return setError("This browser can't tell where it is: type coordinates instead.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        const s = `${p.coords.latitude.toFixed(4)},${p.coords.longitude.toFixed(4)}`;
        setText(s);
        go(`/?at=${s}&radius=${radius}`);
      },
      (e) => {
        setLocating(false);
        setError(`${e.message || "No location"}. Type coordinates instead.`);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  };
  const setRadius = (r: number) => at && go(`/?at=${at.lat},${at.lon}&radius=${r}`, true);

  return (
    <div className="stack">
      <section className="hero stack">
        <h1>What can I hear from here?</h1>
        <p className="muted">
          Radio systems as Trunk Recorder Pro users hear them: their sites, talkgroups and licenses, kept up to date from what their radios decode.
        </p>
        <form className="row search" onSubmit={submit}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Coordinates, a frequency (857.9875), a call sign, BEE00.3A9, or a name" aria-label="Search" autoFocus />
          <button className="btn primary">Search</button>
          <button type="button" className="btn" onClick={mine} disabled={locating}>
            {locating ? "Finding you…" : "Near me"}
          </button>
        </form>
        <p className="muted small">Your location stays in your browser's address bar: the directory is asked for what's near it, and keeps nothing.</p>
      </section>
      {error && <div className="banner bad">{error}</div>}
      {at && (
        <section className="stack">
          <div className="row">
            <h2>Heard within</h2>
            <select value={radius} onChange={(e) => setRadius(Number(e.target.value))} aria-label="Distance">
              {RADII.map((r) => (
                <option key={r} value={r}>{`${r} km`}</option>
              ))}
            </select>
            <span className="muted">of {at.lat.toFixed(3)}, {at.lon.toFixed(3)}</span>
          </div>
          {!near ? (
            <p className="muted">Looking…</p>
          ) : near.length ? (
            <ul className="cards">
              {near.map((s) => (
                <li key={s.id} className="card">
                  <Link to={`/systems/${s.id}`} className="card-title">
                    {s.name || "Unnamed system"}
                  </Link>
                  <div className="muted small">
                    {TYPE[s.type] ?? s.type} · {s.sitesHeard} site{s.sitesHeard === 1 ? "" : "s"} heard nearby · {s.distanceKm} km · {s.talkgroupCount} talkgroups · last heard {ago(s.lastHeard)}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No system shared yet is heard within {radius} km. Try farther, or share yours from Trunk Recorder Pro.</p>
          )}
        </section>
      )}
      {hits && (
        <section className="stack">
          <h2>{hits.length ? `Found for “${q}”` : `Nothing found for “${q}”`}</h2>
          <ul className="cards">
            {hits.map((h, i) => (
              <li key={i} className="card">
                <Link to={h.kind === "talkgroup" ? `/systems/${h.systemId}/talkgroups?q=${encodeURIComponent(h.label.split(" ")[0])}` : `/systems/${h.systemId}`} className="card-title">
                  {h.label}
                </Link>
                <div className="muted small">
                  {h.kind} · {h.systemName || "Unnamed system"}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
