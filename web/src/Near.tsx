// "What can I hear from here?": pick where you are (your browser's location,
// a place or coordinates typed, or a click on the map), and the systems with a
// licensed transmitter in range are listed nearest first, or by an estimate of
// how well each would be heard. The directory is sent only a coarse cell
// (~3 km): distances and the estimate are worked out here.

import { useEffect, useMemo, useState } from "react";
import { ago, get, nameOf, type NearSystem, type PlaceHit } from "./api.ts";
import { TypeBadge, TypeFilter, typesOf, typesParam, typesValue, withQuery } from "./filters.tsx";
import { circle, MapView, type Picked } from "./MapView.tsx";
import { best, distanceKm, level, LEVELS, reachKm } from "./reception.ts";
import { go, Link } from "./router.tsx";

const RADII = [25, 50, 100];
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** "38.9072, -77.0369" (as a map copies it): a point, or null. */
export const latLon = (s: string): [number, number] | null => {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  return m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180 ? [+m[1], +m[2]] : null;
};
const fmt = (p: [number, number]) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
const bearingTo = (a: [number, number], b: [number, number]) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(r(b[1] - a[1])) * Math.cos(r(b[0]));
  const x = Math.cos(r(a[0])) * Math.sin(r(b[0])) - Math.sin(r(a[0])) * Math.cos(r(b[0])) * Math.cos(r(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};
const zoomFor = (km: number) => (km <= 25 ? 9.5 : km <= 50 ? 8.6 : 7.6);

interface Row extends NearSystem {
  /** From exactly where you are (the directory had only your cell). */
  km: number;
  dir: string;
  dbm: number;
}

export function NearPage(props: { query: URLSearchParams }) {
  const q = props.query;
  const at = latLon(q.get("at") ?? "");
  const radius = RADII.includes(Number(q.get("radius"))) ? Number(q.get("radius")) : 50;
  const reception = q.get("reception") === "1";
  const types = typesOf(q);
  const [text, setText] = useState(q.get("at") ?? "");
  const [found, setFound] = useState<PlaceHit[] | null>(null);
  const [systems, setSystems] = useState<NearSystem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const set = (changes: Record<string, string | null>, replace = false) => go(withQuery("/", q, changes), replace);

  useEffect(() => {
    setSystems(null);
    setError(null);
    if (!at) return;
    // Rounded to ~3 km: all the directory is told.
    const [lat, lon] = [Math.round(at[0] / 0.03) * 0.03, Math.round(at[1] / 0.03) * 0.03].map((v) => v.toFixed(2));
    const t = typesParam(types);
    get<{ systems: NearSystem[] }>(`/nearby?lat=${lat}&lon=${lon}&coarse=1&radiusKm=${radius}${t ? `&${t}` : ""}`).then((r) => setSystems(r.systems), (e) => setError(String(e.message ?? e)));
  }, [at?.[0], at?.[1], radius, types.join(",")]);

  const rows: Row[] = useMemo(() => {
    if (!at || !systems) return [];
    return systems
      .map((s) => {
        let km = Infinity;
        let dir = "";
        for (const t of s.transmitters) {
          const d = distanceKm(at, [t.lat, t.lon]);
          if (d < km) [km, dir] = [d, COMPASS[Math.round(bearingTo(at, [t.lat, t.lon]) / 22.5) % 16]];
        }
        return { ...s, km: Math.round(km * 10) / 10, dir, dbm: best(s.transmitters, at) };
      })
      .filter((s) => s.km <= radius)
      .sort((a, b) => (reception ? b.dbm - a.dbm : a.km - b.km));
  }, [systems, at?.[0], at?.[1], reception, radius]);

  const focus = picked ?? (reception ? rows[0]?.id : null) ?? null;
  const layers = useMemo(() => {
    const features = rows.flatMap((s) => s.transmitters.map((t) => ({ type: "Feature" as const, properties: { system: s.id, name: nameOf(s), type: s.type, stale: s.stale }, geometry: { type: "Point" as const, coordinates: [t.lon, t.lat] } })));
    const sel = rows.find((r) => r.id === focus);
    const reach = reception && sel
      ? { type: "FeatureCollection" as const, features: sel.transmitters.flatMap((t) => [circle([t.lat, t.lon], reachKm(t, -112), { level: "Weak" }), circle([t.lat, t.lon], reachKm(t, -105), { level: "Fair" }), circle([t.lat, t.lon], reachKm(t, -95), { level: "Good" })]) }
      : undefined;
    return { sites: { type: "FeatureCollection" as const, features }, me: at, reach };
  }, [rows, focus, reception, at?.[0], at?.[1]]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFound(null);
    const p = latLon(text);
    if (p) return set({ at: fmt(p) });
    if (text.trim().length < 3) return;
    const r = await get<{ places: PlaceHit[] }>(`/search?q=${encodeURIComponent(text.trim())}`).catch(() => ({ places: [] }));
    setFound(r.places.filter((x) => x.kind !== "state"));
  };
  const placeAt = async (p: PlaceHit) => {
    const r = await get<{ lat: number; lon: number }>(p.kind === "county" ? `/places/${p.state}/${p.geoid}` : `/places/${p.state}/${p.county}/${p.geoid}`).catch(() => null);
    setFound(null);
    if (r?.lat != null) {
      setText(p.name);
      set({ at: fmt([r.lat, r.lon]) });
    }
  };
  const mine = () => {
    if (!("geolocation" in navigator)) return setError("This browser can't tell where it is: type a place or coordinates, or click the map.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        const s = fmt([p.coords.latitude, p.coords.longitude]);
        setText(s);
        set({ at: s });
      },
      (e) => {
        setLocating(false);
        setError(`${e.message || "No location"}. Type a place or coordinates, or click the map.`);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  };
  const onPick = (p: Picked) => {
    if (p.kind === "site") setPicked(String(p.props.system));
    else if (p.kind === "point" || p.kind === "county") {
      setText(fmt(p.lngLat));
      set({ at: fmt(p.lngLat) }, true);
    }
  };

  return (
    <div className="split">
      <section className="split-side stack">
        <div className="stack">
          <h1>What can I hear from here?</h1>
          <p className="muted small">Pick where you are: the systems with a licensed transmitter in range, as Trunk Recorder Pro users share them.</p>
        </div>
        <form className="row search" onSubmit={submit}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="A city, county, or coordinates" aria-label="Where you are" />
          <button className="btn primary">Go</button>
          <button type="button" className="btn" onClick={mine} disabled={locating}>
            {locating ? "Finding you…" : "Use my location"}
          </button>
        </form>
        {found && (
          <ul className="cards">
            {!found.length && <li className="muted small">No place by that name.</li>}
            {found.map((p) => (
              <li key={p.geoid}>
                <button className="linkish" onClick={() => placeAt(p)}>
                  {p.name}, {p.state}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Or click the map. Only a rough area (about 3 km) is sent to the directory; your location isn't kept.</p>
        <TypeFilter types={types} onChange={(t) => set({ types: typesValue(t) }, true)} />
        {at && (
          <div className="row">
            <label className="row small">
              Within
              <select value={radius} onChange={(e) => set({ radius: e.target.value }, true)} aria-label="Distance">
                {RADII.map((r) => (
                  <option key={r} value={r}>
                    {r} km
                  </option>
                ))}
              </select>
            </label>
            <label className="toggle small">
              <input type="checkbox" checked={reception} onChange={(e) => set({ reception: e.target.checked ? "1" : null }, true)} />
              Estimate reception
            </label>
          </div>
        )}
        {reception && at && (
          <p className="muted small">
            An estimate from each transmitter's licensed power and height, with no terrain: hills, buildings and being indoors can make it 10–30 dB worse.
            {" "}
            {LEVELS.map((l) => `${l.name} ≥ ${l.min} dBm`).join(" · ")}.
          </p>
        )}
        {error && <div className="banner bad">{error}</div>}
        {at && !systems && !error && <p className="muted">Looking…</p>}
        {at && systems && (
          <ul className="cards">
            {!rows.length && <li className="muted">No shared system has a transmitter within {radius} km. The map shows what's licensed nearby.</li>}
            {rows.map((s) => (
              <li key={s.id} className={`card${focus === s.id ? " focus" : ""}`} onMouseEnter={() => setPicked(s.id)}>
                <div className="row">
                  <Link to={`/systems/${s.id}`} className="card-title">
                    {nameOf(s)}
                  </Link>
                  <TypeBadge type={s.type} />
                  <span className="spacer" />
                  {reception && <span className={`level level-${level(s.dbm).toLowerCase()}`}>{level(s.dbm)}</span>}
                </div>
                <div className="kv muted small">
                  <span>
                    {s.km} km {s.dir}
                  </span>
                  {s.bandMhz && <span>{Math.round(s.bandMhz)} MHz</span>}
                  {reception && Number.isFinite(s.dbm) && <span>~{Math.round(s.dbm)} dBm</span>}
                  {s.name && s.licensee && <span>{s.licensee}</span>}
                  <span>{s.talkgroupCount} talkgroups</span>
                  <span className={s.stale ? "stale" : ""}>heard {ago(s.lastHeard)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <MapView className="split-map" label="Map: click where you are" view={at ? { center: at, zoom: zoomFor(radius) } : { center: [39.5, -97.5], zoom: 3.3 }} layers={layers} onPick={onPick} />
    </div>
  );
}
