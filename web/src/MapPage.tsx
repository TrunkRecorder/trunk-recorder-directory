// Every shared system on one map: counties shaded by how many there are
// (zoomed out), each site's transmitters by kind (zoomed in), and, when asked
// for, the trunked systems licensed nearby that no one has shared yet. Where
// the map is, its filters and that layer are in the URL.

import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection, Point } from "geojson";
import { get, titleCase, TYPE, type MapSite } from "./api.ts";
import { ALL_TYPES, TypeFilter, typesOf, typesParam, typesValue, withQuery } from "./filters.tsx";
import { TYPE_COLOR } from "./colors.ts";
import { MapView, sitePoints, type Picked, type View } from "./MapView.tsx";
import { go, Link } from "./router.tsx";

interface Licensed {
  callSign: string;
  licensee: string;
  serviceDesc: string;
  lat: number;
  lon: number;
  stationClass: string;
  frequencies: number;
}

const LICENSED_ZOOM = 8;
const US: View = { center: [39.5, -97.5], zoom: 3.4 };

function viewOf(q: URLSearchParams): View {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(q.get("at") ?? "");
  const z = Number(q.get("z"));
  return m ? { center: [+m[1], +m[2]], zoom: Number.isFinite(z) && z > 0 ? z : 6 } : US;
}

export function MapPage(props: { query: URLSearchParams }) {
  const q = props.query;
  const types = typesOf(q);
  const showLicensed = q.get("licensed") === "1";
  const view = viewOf(q);
  const [sites, setSites] = useState<MapSite[] | null>(null);
  const [counties, setCounties] = useState<Record<string, number>>({});
  const [licensed, setLicensed] = useState<Licensed[]>([]);
  const [licensedNote, setLicensedNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bounds = useRef<[number, number, number, number] | null>(null);
  const zoom = useRef(view.zoom);
  const set = (changes: Record<string, string | null>) => go(withQuery("/map", q, changes), true);

  useEffect(() => {
    const t = typesParam(types);
    get<{ sites: MapSite[] }>(`/map/sites${t ? `?${t}` : ""}`).then((r) => setSites(r.sites), (e) => setError(String(e.message ?? e)));
    get<{ counties: Record<string, number> }>(`/map/counties${t ? `?${t}` : ""}`).then((r) => setCounties(r.counties), () => {});
  }, [types.join(",")]);

  const loadLicensed = () => {
    const b = bounds.current;
    if (!showLicensed || !b) return setLicensed([]);
    if (zoom.current < LICENSED_ZOOM) {
      setLicensed([]);
      return setLicensedNote("Zoom in (to a few counties) to see licensed systems.");
    }
    get<{ licensed: Licensed[]; tooBig?: boolean }>(`/map/licensed?bbox=${b.map((v) => v.toFixed(3)).join(",")}`).then(
      (r) => {
        setLicensed(r.licensed);
        setLicensedNote(r.tooBig ? "Zoom in (to a few counties) to see licensed systems." : null);
      },
      () => setLicensedNote("Licensed systems aren't available right now."),
    );
  };
  useEffect(loadLicensed, [showLicensed]);
  useEffect(() => {
    if (showLicensed && view.zoom < LICENSED_ZOOM) setLicensedNote("Zoom in (to a few counties) to see licensed systems.");
  }, [showLicensed]);

  const layers = useMemo(() => {
    const lic: FeatureCollection<Point> = { type: "FeatureCollection", features: licensed.map((l) => ({ type: "Feature", properties: { ...l }, geometry: { type: "Point", coordinates: [l.lon, l.lat] } })) };
    return { counties, sites: sitePoints(sites ?? []), licensed: lic };
  }, [sites, counties, licensed]);

  const onMove = (v: View, b: [number, number, number, number]) => {
    bounds.current = b;
    zoom.current = v.zoom;
    set({ at: `${v.center[0]},${v.center[1]}`, z: String(v.zoom) });
    loadLicensed();
  };
  const onPick = (p: Picked) => {
    if (p.kind === "county") go(withQuery(`/browse/${p.props.state}/${p.props.geoid}`, new URLSearchParams(typesValue(types) ? { types: typesValue(types)! } : {}), {}));
    else setPicked(p.kind === "point" ? null : p);
  };
  const count = new Set((sites ?? []).map((s) => s.system)).size;

  return (
    <div className="map-page">
      <MapView className="map-full" label="Map of shared systems" view={view} layers={layers} onMove={onMove} onPick={onPick} />
      <aside className="map-panel stack">
        <div className="row">
          <h2>Shared systems</h2>
          <span className="spacer" />
          <span className="muted small">{sites ? `${count} on the map` : "Loading…"}</span>
        </div>
        <TypeFilter types={types} onChange={(t) => set({ types: typesValue(t) })} />
        <label className="toggle small">
          <input type="checkbox" checked={showLicensed} onChange={(e) => set({ licensed: e.target.checked ? "1" : null })} />
          Licensed, not shared yet
          <span className="ring" aria-hidden="true" />
        </label>
        {showLicensed && licensedNote && <p className="muted small">{licensedNote}</p>}
        <div className="legend small muted">
          {ALL_TYPES.filter((t) => types.includes(t)).map((t) => (
            <span key={t}>
              <span className="dot" style={{ background: TYPE_COLOR[t] }} aria-hidden="true" />
              {TYPE[t]}
            </span>
          ))}
          <span>Faded: not heard for a month</span>
          <span>Shaded: counties with systems (click one)</span>
        </div>
        {error && <div className="banner bad">{error}</div>}
        {picked?.kind === "site" && (
          <div className="card">
            <Link to={`/systems/${picked.props.system}`} className="card-title">
              {String(picked.props.name) || "Unnamed system"}
            </Link>
            <div className="muted small">{TYPE[String(picked.props.type)] ?? String(picked.props.type)} · a transmitter of one of its sites</div>
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
        <p className="small">
          <Link to={withQuery("/browse", new URLSearchParams(), { types: typesValue(types) })}>Browse by state, county and city</Link>
        </p>
      </aside>
    </div>
  );
}

