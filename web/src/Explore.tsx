// The map: every shared system's towers, and a panel that follows what you're
// doing. Zoomed out, how many systems each state has; zoomed in, the systems
// in view; with your location set (your browser's, a place or ZIP code typed,
// or "Set my location here" on the map), the systems in range, nearest first
// or by an estimate of how well each would be heard. Click a tower and every
// tower of its system is ringed (a system can have many). Where the map is,
// your location and every choice are in the URL. Only a location rounded to
// ~3 km is sent to the directory; distances and the estimate are worked out here.

import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection, Point } from "geojson";
import { ago, get, nameOf, titleCase, TYPE, type MapSite, type NearSystem } from "./api.ts";
import { TYPE_COLOR } from "./colors.ts";
import { ALL_TYPES, TypeBadge, TypeFilter, typesOf, typesParam, typesValue, withQuery } from "./filters.tsx";
import { MapView, sitePoints, type Picked, type View } from "./MapView.tsx";
import { best, coverage, distanceKm, level, LEVELS } from "./reception.ts";
import { go, Link } from "./router.tsx";

const RADII = [25, 50, 100];
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
/** The lower 48, fitted beside the panel. */
const US: View = { center: [39.5, -97.5], zoom: 3.4, fit: [-124.8, 24.5, -66.9, 49.4] };
/** Below this zoom the panel counts by state; above it, it lists the systems in view. */
const IN_VIEW_ZOOM = 6;
const LICENSED_ZOOM = 8;

interface PlaceHit { geoid: string; kind: string; state: string; name: string; lat: number | null; lon: number | null }
interface StateRow { state: string; name: string; systems: number; byType: Record<string, number> }
interface Licensed { callSign: string; licensee: string; serviceDesc: string; lat: number; lon: number; stationClass: string; frequencies: number }

/** "38.9072, -77.0369" (as a map copies it): a point, or null. */
export const latLon = (s: string | null): [number, number] | null => {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s ?? "");
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

export function ExplorePage(props: { query: URLSearchParams }) {
  const q = props.query;
  const types = typesOf(q);
  const showLicensed = q.get("licensed") === "1";
  const radius = RADII.includes(Number(q.get("radius"))) ? Number(q.get("radius")) : 50;
  const reception = q.get("reception") === "1";
  // (An older "near me" link had your location as `at`, with a radius.)
  const me = latLon(q.get("me")) ?? (q.get("radius") || q.get("reception") ? latLon(q.get("at")) : null);
  const at = latLon(q.get("at"));
  const z = Number(q.get("z"));
  const view: View = at ? { center: at, zoom: Number.isFinite(z) && z > 0 ? z : me ? zoomFor(radius) : 6 } : me ? { center: me, zoom: zoomFor(radius) } : US;
  const selected = q.get("sel");
  const set = (changes: Record<string, string | null>, replace = true) => go(withQuery("/", q, changes), replace);

  const [sites, setSites] = useState<MapSite[] | null>(null);
  const [counties, setCounties] = useState<Record<string, number>>({});
  const [states, setStates] = useState<StateRow[] | null>(null);
  const [near, setNear] = useState<NearSystem[] | null>(null);
  const [bounds, setBounds] = useState<[number, number, number, number] | null>(null);
  const [zoom, setZoom] = useState(view.zoom);
  const [hover, setHover] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Everything on the map (of these types), and the counts zoomed out.
  useEffect(() => {
    const t = typesParam(types);
    get<{ sites: MapSite[] }>(`/map/sites${t ? `?${t}` : ""}`).then((r) => setSites(r.sites), (e) => setError(String(e.message ?? e)));
    get<{ counties: Record<string, number> }>(`/map/counties${t ? `?${t}` : ""}`).then((r) => setCounties(r.counties), () => {});
    get<{ states: StateRow[] }>(`/places${t ? `?${t}` : ""}`).then((r) => setStates(r.states), () => {});
  }, [types.join(",")]);

  // Near you: rounded to ~3 km, all the directory is told.
  useEffect(() => {
    setNear(null);
    if (!me) return;
    const [lat, lon] = [Math.round(me[0] / 0.03) * 0.03, Math.round(me[1] / 0.03) * 0.03].map((v) => v.toFixed(2));
    const t = typesParam(types);
    get<{ systems: NearSystem[] }>(`/nearby?lat=${lat}&lon=${lon}&coarse=1&radiusKm=${radius}${t ? `&${t}` : ""}`).then((r) => setNear(r.systems), (e) => setError(String(e.message ?? e)));
  }, [me?.[0], me?.[1], radius, types.join(",")]);

  const nearRows = useMemo(() => {
    if (!me || !near) return [];
    return near
      .map((s) => {
        let km = Infinity;
        let dir = "";
        for (const t of s.transmitters) {
          const d = distanceKm(me, [t.lat, t.lon]);
          if (d < km) [km, dir] = [d, COMPASS[Math.round(bearingTo(me, [t.lat, t.lon]) / 22.5) % 16]];
        }
        return { ...s, km: Math.round(km * 10) / 10, dir, dbm: best(s.transmitters, me) };
      })
      .filter((s) => s.km <= radius)
      .sort((a, b) => (reception ? b.dbm - a.dbm : a.km - b.km));
  }, [near, me?.[0], me?.[1], reception, radius]);

  // The systems in view: each system once, however many of its towers are.
  const inView = useMemo(() => {
    if (!sites || !bounds) return [];
    const [w, s, e, n] = bounds;
    const by = new Map<string, { system: string; name: string; type: string; stale: boolean; towers: number }>();
    for (const x of sites) {
      const towers = x.at.filter(([lat, lon]) => lat >= s && lat <= n && lon >= w && lon <= e).length;
      if (!towers) continue;
      const v = by.get(x.system) ?? { system: x.system, name: x.name, type: x.type, stale: x.stale, towers: 0 };
      v.towers += towers;
      by.set(x.system, v);
    }
    return [...by.values()].sort((a, b) => b.towers - a.towers || a.name.localeCompare(b.name));
  }, [sites, bounds]);

  // The licensed layer: the site's files by 1° cell (made per FCC refresh), the shared call signs left out.
  const [licensed, setLicensed] = useState<Licensed[]>([]);
  const cellCache = useRef(new Map<string, Promise<Licensed[]>>());
  const known = useRef<{ cells: Set<string>; shared: Set<string> } | null>(null);
  useEffect(() => {
    if (!showLicensed || !bounds || zoom < LICENSED_ZOOM) return setLicensed([]);
    let gone = false;
    (async () => {
      known.current ??= await Promise.all([
        fetch("/directory/geo/licensed/index.json").then((r) => (r.ok ? r.json() : { cells: [] })) as Promise<{ cells: string[] }>,
        get<{ callSigns: string[] }>("/map/callsigns"),
      ]).then(([i, c]) => ({ cells: new Set(i.cells), shared: new Set(c.callSigns) }));
      const k = known.current!;
      const [w, s, e, n] = bounds;
      const want: string[] = [];
      for (let lat = Math.floor(s); lat <= Math.floor(n); lat++) for (let lon = Math.floor(w); lon <= Math.floor(e); lon++) if (k.cells.has(`${lat}_${lon}`)) want.push(`${lat}_${lon}`);
      const got = await Promise.all(
        want.slice(0, 40).map((c) => {
          let p = cellCache.current.get(c);
          if (!p) {
            p = fetch(`/directory/geo/licensed/${c}.json`)
              .then((r) => r.json() as Promise<{ spots: [string, string, string, number, number, string, number][] }>)
              .then((j) => j.spots.map(([callSign, licensee, serviceDesc, lat, lon, stationClass, frequencies]) => ({ callSign, licensee, serviceDesc, lat, lon, stationClass, frequencies })));
            cellCache.current.set(c, p);
          }
          return p;
        }),
      );
      if (!gone) setLicensed(got.flat().filter((l) => !k.shared.has(l.callSign) && l.lat >= s && l.lat <= n && l.lon >= w && l.lon <= e));
    })().catch(() => {});
    return () => {
      gone = true;
    };
  }, [showLicensed, bounds, zoom]);

  const focus = selected ?? hover ?? (me && reception ? nearRows[0]?.id : null) ?? null;
  const layers = useMemo(() => {
    const lic: FeatureCollection<Point> = { type: "FeatureCollection", features: licensed.map((l) => ({ type: "Feature", properties: { ...l }, geometry: { type: "Point", coordinates: [l.lon, l.lat] } })) };
    const sel = me && reception ? nearRows.find((r) => r.id === focus) : null;
    return { counties, sites: sitePoints(sites ?? []), licensed: lic, me, reach: sel ? coverage(sel.transmitters) : undefined };
  }, [sites, counties, licensed, me?.[0], me?.[1], reception, focus, nearRows]);

  const onMove = (v: View, b: [number, number, number, number]) => {
    setBounds(b);
    setZoom(v.zoom);
    set({ at: `${v.center[0]},${v.center[1]}`, z: String(v.zoom) });
  };
  const [picked, setPicked] = useState<Picked | null>(null);
  const onPick = (p: Picked) => {
    if (p.kind === "site") {
      setPicked(null);
      set({ sel: String(p.props.system) });
    } else {
      set({ sel: null });
      setPicked(p.kind === "point" ? null : p);
    }
  };
  const setMe = (p: [number, number] | null) => set({ me: p ? fmt(p) : null, at: p ? fmt(p) : q.get("at"), z: p ? String(zoomFor(radius)) : q.get("z"), sel: null }, false);

  const selSystem = selected ? (sites ?? []).filter((x) => x.system === selected) : [];
  const selTowers = selSystem.reduce((a, x) => a + x.at.length, 0);

  return (
    <div className="map-page">
      <MapView
        className="map-full"
        label="Map of shared systems"
        view={view}
        layers={layers}
        selected={focus}
        onMove={onMove}
        onPick={onPick}
        pointAction={{ label: "Set my location here", run: (p) => setMe(p) }}
      />
      <aside className="map-panel stack">
        <WhereBox me={me} onSet={setMe} onError={setError} />
        <TypeFilter types={types} onChange={(t) => set({ types: typesValue(t) })} />
        <label className="toggle small">
          <input type="checkbox" checked={showLicensed} onChange={(e) => set({ licensed: e.target.checked ? "1" : null })} />
          Licensed, not shared yet
          <span className="ring" aria-hidden="true" />
        </label>
        {showLicensed && zoom < LICENSED_ZOOM && <p className="muted small">Zoom in (to a few counties) to see licensed systems.</p>}
        {error && <div className="banner bad">{error}</div>}

        {selected && (
          <div className="card focus">
            <div className="row">
              <Link to={`/systems/${selected}`} className="card-title">
                {selSystem[0]?.name ? titleCase(selSystem[0].name) : "Unnamed system"}
              </Link>
              {selSystem[0] && <TypeBadge type={selSystem[0].type} />}
              <span className="spacer" />
              <button className="linkish small" onClick={() => set({ sel: null })}>
                Clear
              </button>
            </div>
            <div className="muted small">
              {selTowers} tower{selTowers === 1 ? "" : "s"}, ringed on the map · {selSystem.length} site{selSystem.length === 1 ? "" : "s"}
            </div>
          </div>
        )}
        {picked?.kind === "licensed" && (
          <div className="card">
            <div className="card-title">{titleCase(String(picked.props.licensee)) || String(picked.props.callSign)}</div>
            <div className="muted small">
              {String(picked.props.callSign)} · {String(picked.props.serviceDesc)} · {String(picked.props.frequencies)} frequencies here
            </div>
            <p className="small">Licensed, but no one has shared it yet. Recording it with Trunk Recorder Pro? Turn on Share in its Setup.</p>
          </div>
        )}
        {picked?.kind === "county" && (
          <div className="card">
            <Link to={withQuery(`/browse/${picked.props.state}/${picked.props.geoid}`, new URLSearchParams(), { types: typesValue(types) })} className="card-title">
              {String(picked.props.name)}, {String(picked.props.state)}
            </Link>
            <div className="muted small">{counties[String(picked.props.geoid)] ?? 0} shared systems: browse them</div>
          </div>
        )}

        {me ? (
          <section className="stack">
            <div className="row">
              <h2>Near you</h2>
              <span className="spacer" />
              <select value={radius} onChange={(e) => set({ radius: e.target.value })} aria-label="Distance">
                {RADII.map((r) => (
                  <option key={r} value={r}>
                    within {r} km
                  </option>
                ))}
              </select>
            </div>
            <label className="toggle small">
              <input type="checkbox" checked={reception} onChange={(e) => set({ reception: e.target.checked ? "1" : null })} />
              Estimate reception
            </label>
            {reception && (
              <p className="muted small">
                From each tower's licensed power and height, with no terrain: hills, buildings and being indoors can make it 10–30 dB worse. {LEVELS.map((l) => `${l.name} ≥ ${l.min} dBm`).join(" · ")}. The map shades where the system picked would be heard.
              </p>
            )}
            {!near && <p className="muted small">Looking…</p>}
            {near && !nearRows.length && <p className="muted small">No shared system has a tower within {radius} km.</p>}
            <ul className="cards">
              {nearRows.map((s) => (
                <li key={s.id} className={`card${focus === s.id ? " focus" : ""}`} onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)}>
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
                    {reception && Number.isFinite(s.dbm) && <span>about {Math.round(s.dbm)} dBm</span>}
                    <span>{s.transmitters.length} tower{s.transmitters.length === 1 ? "" : "s"}</span>
                    <span className={s.stale ? "stale" : ""}>heard {ago(s.lastHeard)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : zoom >= IN_VIEW_ZOOM ? (
          <section className="stack">
            <div className="row">
              <h2>Systems in view</h2>
              <span className="spacer" />
              <span className="muted small">{inView.length}</span>
            </div>
            {!inView.length && <p className="muted small">No shared system here yet.{showLicensed ? "" : " Turn on licensed systems to see what's licensed."}</p>}
            <ul className="cards">
              {inView.map((s) => (
                <li key={s.system} className={`card compact${focus === s.system ? " focus" : ""}`} onMouseEnter={() => setHover(s.system)} onMouseLeave={() => setHover(null)}>
                  <div className="row">
                    <Link to={`/systems/${s.system}`} className="card-title">
                      {s.name ? titleCase(s.name) : "Unnamed system"}
                    </Link>
                    <TypeBadge type={s.type} />
                  </div>
                  <div className="muted small">
                    {s.towers} tower{s.towers === 1 ? "" : "s"} in view{s.stale ? " · not heard for a month" : ""}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className="stack">
            <h2>By state</h2>
            {!states && <p className="muted small">Loading…</p>}
            {states && !states.length && <p className="muted small">No shared system is on the map yet.</p>}
            <ul className="place-list one">
              {(states ?? []).map((s) => (
                <li key={s.state}>
                  <Link to={withQuery(`/browse/${s.state}`, new URLSearchParams(), { types: typesValue(types) })}>{s.name}</Link>
                  <span className="muted small">
                    {s.systems} system{s.systems === 1 ? "" : "s"} · {Object.entries(s.byType).map(([k, n]) => `${n} ${TYPE[k] ?? k}`).join(", ")}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted small">Zoom in for the systems in view, or set your location.</p>
          </section>
        )}

        <div className="legend small muted">
          {ALL_TYPES.filter((t) => types.includes(t)).map((t) => (
            <span key={t}>
              <span className="dot" style={{ background: TYPE_COLOR[t] }} aria-hidden="true" />
              {TYPE[t]}
            </span>
          ))}
          <span>Each dot is a tower: a system can have many. Click one to ring them all.</span>
        </div>
      </aside>
    </div>
  );
}

/** Where you are: your browser's location, a place or ZIP code typed, or coordinates. */
function WhereBox(props: { me: [number, number] | null; onSet: (p: [number, number] | null) => void; onError: (e: string | null) => void }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<PlaceHit[] | null>(null);
  const [locating, setLocating] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFound(null);
    props.onError(null);
    const p = latLon(text);
    if (p) return props.onSet(p);
    if (text.trim().length < 3) return;
    const r = await get<{ places: PlaceHit[] }>(`/search?q=${encodeURIComponent(text.trim())}`).catch(() => ({ places: [] as PlaceHit[] }));
    const places = r.places.filter((x) => x.kind !== "state" && x.lat != null);
    // One answer (a ZIP code, "City, ST"): straight there.
    if (places.length === 1) return pick(places[0]);
    setFound(places);
  };
  const pick = (p: PlaceHit) => {
    setFound(null);
    setText(p.kind === "zip" ? p.name : `${p.name}, ${p.state}`);
    props.onSet([p.lat!, p.lon!]);
  };
  const mine = () => {
    if (!("geolocation" in navigator)) return props.onError("This browser can't tell where it is: type a place or ZIP code, or right-click the map.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        props.onSet([p.coords.latitude, p.coords.longitude]);
      },
      (e) => {
        setLocating(false);
        props.onError(`${e.message || "No location"}. Type a place or ZIP code, or click the map.`);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  };
  return (
    <div className="stack">
      <form className="row search" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="City, ST · ZIP code · coordinates" aria-label="Where you are" />
        <button className="btn primary">Go</button>
      </form>
      <div className="row small">
        <button type="button" className="btn small" onClick={mine} disabled={locating}>
          {locating ? "Finding you…" : "Use my location"}
        </button>
        {props.me && (
          <button type="button" className="linkish" onClick={() => props.onSet(null)}>
            Clear my location
          </button>
        )}
      </div>
      {found && (
        <ul className="cards">
          {!found.length && <li className="muted small">No place by that name. Try "City, ST" or a ZIP code.</li>}
          {found.map((p) => (
            <li key={p.geoid}>
              <button className="linkish" onClick={() => pick(p)}>
                {p.name}, {p.state}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!props.me && <p className="muted small">Or click the map where you are. Only a rough area (about 3 km) is sent to the directory.</p>}
    </div>
  );
}
