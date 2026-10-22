// A map (MapLibre, loaded only where there's a map) on the directory's own
// basemap, with its layers over it: counties shaded by how many systems they
// have, sites' transmitters by type, licensed systems no one has shared,
// where you are, and how far transmitters reach. Light or dark as the page is.

import { useEffect, useRef, useState } from "react";
import type { FeatureCollection, Point, Polygon } from "geojson";
import type { GeoJSONSource, Map as MlMap, MapGeoJSONFeature } from "maplibre-gl";
import { TYPE_COLOR } from "./colors.ts";
import { useTheme } from "./theme.ts";

export interface View {
  center: [number, number];
  zoom: number;
}

export interface Layers {
  /** Count of systems per county GEOID: shaded on /directory/geo/counties.json. */
  counties?: Record<string, number>;
  /** Transmitters: points with { system, site, name, type, stale }. */
  sites?: FeatureCollection<Point>;
  /** Licensed, not shared: points with { callSign, licensee, serviceDesc }. */
  licensed?: FeatureCollection<Point>;
  /** Where you are. */
  me?: [number, number] | null;
  /** How far transmitters reach: polygons with { level }. */
  reach?: FeatureCollection<Polygon>;
}

export type Picked =
  | { kind: "site"; props: Record<string, unknown>; lngLat: [number, number] }
  | { kind: "licensed"; props: Record<string, unknown>; lngLat: [number, number] }
  | { kind: "county"; props: Record<string, unknown>; lngLat: [number, number] }
  | { kind: "point"; lngLat: [number, number] };

const empty = (): FeatureCollection => ({ type: "FeatureCollection", features: [] });
const typeColor = ["match", ["get", "type"], ...Object.entries(TYPE_COLOR).flat(), "#888888"];

/** The directory's layers, added again whenever the style is (a theme change replaces it). */
function addLayers(map: MlMap, theme: "light" | "dark") {
  const dark = theme === "dark";
  map.addSource("counties", { type: "geojson", data: `${location.origin}/directory/geo/counties.json`, promoteId: "geoid" });
  map.addSource("reach", { type: "geojson", data: empty() });
  map.addSource("licensed", { type: "geojson", data: empty() });
  map.addSource("sites", { type: "geojson", data: empty() });
  map.addSource("me", { type: "geojson", data: empty() });
  // Counties with systems, shaded (fading out as sites come in).
  map.addLayer({
    id: "counties-fill", type: "fill", source: "counties",
    paint: {
      "fill-color": dark ? "#5c9bff" : "#2f7ff5",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, ["case", [">", ["coalesce", ["feature-state", "n"], 0], 0], ["min", 0.5, ["+", 0.12, ["*", 0.08, ["feature-state", "n"]]]], 0], 9, ["case", [">", ["coalesce", ["feature-state", "n"], 0], 0], 0.06, 0]],
    },
  });
  map.addLayer({ id: "counties-line", type: "line", source: "counties", minzoom: 5, paint: { "line-color": dark ? "#3a414b" : "#c9ccd2", "line-width": 0.5, "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0, 7, 0.8] } });
  map.addLayer({ id: "reach-fill", type: "fill", source: "reach", paint: { "fill-color": ["match", ["get", "level"], "Good", "#1f9e74", "Fair", "#e0b31e", "#d2457a"], "fill-opacity": 0.12 } });
  map.addLayer({ id: "reach-line", type: "line", source: "reach", paint: { "line-color": ["match", ["get", "level"], "Good", "#1f9e74", "Fair", "#e0b31e", "#d2457a"], "line-width": 1, "line-opacity": 0.6 } });
  map.addLayer({
    id: "licensed", type: "circle", source: "licensed", minzoom: 7,
    paint: { "circle-radius": 4, "circle-color": "transparent", "circle-stroke-color": dark ? "#8b939e" : "#7d838c", "circle-stroke-width": 1.2, "circle-stroke-opacity": 0.8 },
  });
  map.addLayer({
    id: "sites", type: "circle", source: "sites",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.5, 8, 4.5, 12, 6],
      "circle-color": typeColor as never,
      "circle-opacity": ["case", ["get", "stale"], 0.45, 0.95],
      "circle-stroke-color": dark ? "#15181c" : "#ffffff",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 8, 1.5],
    },
  });
  map.addLayer({ id: "me-halo", type: "circle", source: "me", paint: { "circle-radius": 11, "circle-color": dark ? "#e8ebef" : "#16191d", "circle-opacity": 0.15 } });
  map.addLayer({ id: "me", type: "circle", source: "me", paint: { "circle-radius": 5, "circle-color": dark ? "#e8ebef" : "#16191d", "circle-stroke-color": dark ? "#15181c" : "#ffffff", "circle-stroke-width": 2 } });
}

export function MapView(props: { view: View; layers: Layers; onMove?: (v: View, bounds: [number, number, number, number]) => void; onPick?: (p: Picked) => void; className?: string; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const layersRef = useRef(props.layers);
  const cb = useRef(props);
  cb.current = props;
  layersRef.current = props.layers;
  const { effective } = useTheme();
  const [failed, setFailed] = useState<string | null>(null);
  const styleOf = useRef<((t: "light" | "dark") => import("maplibre-gl").StyleSpecification) | null>(null);

  // Put the data in (after each style load, too).
  const sync = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const l = layersRef.current;
    (m.getSource("sites") as GeoJSONSource | undefined)?.setData(l.sites ?? empty());
    (m.getSource("licensed") as GeoJSONSource | undefined)?.setData(l.licensed ?? empty());
    (m.getSource("reach") as GeoJSONSource | undefined)?.setData(l.reach ?? empty());
    (m.getSource("me") as GeoJSONSource | undefined)?.setData(l.me ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [l.me[1], l.me[0]] } }] } : empty());
    if (m.getSource("counties")) {
      m.removeFeatureState({ source: "counties" });
      for (const [geoid, n] of Object.entries(l.counties ?? {})) m.setFeatureState({ source: "counties", id: geoid }, { n });
    }
  };

  useEffect(() => {
    let gone = false;
    (async () => {
      const ml = await import("maplibre-gl");
      const { basemapStyle } = await import("./mapStyle.ts");
      styleOf.current = basemapStyle;
      // @ts-expect-error: a stylesheet, which Vite bundles.
      await import("maplibre-gl/dist/maplibre-gl.css");
      if (gone || !el.current) return;
      const m = new ml.Map({ container: el.current, style: basemapStyle(effective), center: [props.view.center[1], props.view.center[0]], zoom: props.view.zoom, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false });
      m.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      m.touchZoomRotate.disableRotation();
      map.current = m;
      m.on("style.load", () => {
        addLayers(m, document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light");
        ready.current = true;
        // (The counties' data loads after; their shading needs it.)
        m.once("sourcedata", () => sync());
        sync();
      });
      m.on("moveend", () => {
        const c = m.getCenter();
        const b = m.getBounds();
        cb.current.onMove?.({ center: [Math.round(c.lat * 1e4) / 1e4, Math.round(c.lng * 1e4) / 1e4], zoom: Math.round(m.getZoom() * 10) / 10 }, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      });
      m.on("click", (e: { point: import("maplibre-gl").PointLike; lngLat: { lat: number; lng: number } }) => {
        const hit = m.queryRenderedFeatures(e.point, { layers: ["sites", "licensed", "counties-fill"] }) as MapGeoJSONFeature[];
        const at: [number, number] = [e.lngLat.lat, e.lngLat.lng];
        const f = hit.find((h) => h.layer.id === "sites") ?? hit.find((h) => h.layer.id === "licensed") ?? hit.find((h) => h.layer.id === "counties-fill" && (h.state?.n ?? 0) > 0);
        if (f?.layer.id === "sites") cb.current.onPick?.({ kind: "site", props: f.properties, lngLat: at });
        else if (f?.layer.id === "licensed") cb.current.onPick?.({ kind: "licensed", props: f.properties, lngLat: at });
        else if (f) cb.current.onPick?.({ kind: "county", props: f.properties, lngLat: at });
        else cb.current.onPick?.({ kind: "point", lngLat: at });
      });
      for (const id of ["sites", "licensed"]) {
        m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
      }
      m.on("error", (e: { error?: { message?: string } }) => {
        if (/tiles|glyph|fonts/.test(String(e.error?.message ?? ""))) setFailed("The map's basemap isn't available here: the directory's data still is.");
      });
    })().catch((e) => setFailed(`The map couldn't load (${e instanceof Error ? e.message : String(e)}).`));
    return () => {
      gone = true;
      map.current?.remove();
      map.current = null;
      ready.current = false;
    };
  }, []);

  // The theme: the basemap's style again, and the directory's layers on it.
  useEffect(() => {
    if (!map.current || !styleOf.current) return;
    ready.current = false;
    map.current.setStyle(styleOf.current(effective));
  }, [effective]);

  useEffect(sync, [props.layers]);

  // A view asked for from outside (a place picked): flown to.
  const last = useRef(props.view);
  useEffect(() => {
    const m = map.current;
    const v = props.view;
    if (!m || (v.center[0] === last.current.center[0] && v.center[1] === last.current.center[1] && v.zoom === last.current.zoom)) return;
    last.current = v;
    const c = m.getCenter();
    if (Math.abs(c.lat - v.center[0]) > 1e-4 || Math.abs(c.lng - v.center[1]) > 1e-4 || Math.abs(m.getZoom() - v.zoom) > 0.05) m.easeTo({ center: [v.center[1], v.center[0]], zoom: v.zoom });
  }, [props.view.center[0], props.view.center[1], props.view.zoom]);

  return (
    <div className={`map ${props.className ?? ""}`} role="region" aria-label={props.label}>
      <div ref={el} className="map-canvas" />
      {failed && <div className="map-note small">{failed}</div>}
    </div>
  );
}

/** Transmitters as map points. */
export function sitePoints(sites: { site: string; system: string; name: string; type: string; stale: boolean; at: [number, number][] }[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: sites.flatMap((s) => s.at.map(([lat, lon]) => ({ type: "Feature" as const, properties: { site: s.site, system: s.system, name: s.name, type: s.type, stale: s.stale }, geometry: { type: "Point" as const, coordinates: [lon, lat] } }))),
  };
}

/** A circle (polygon) of `km` around [lat, lon]. */
export function circle(at: [number, number], km: number, props: Record<string, unknown>): FeatureCollection<Polygon>["features"][number] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    const dLat = (km / 111.32) * Math.cos(a);
    const dLon = (km / (111.32 * Math.cos((at[0] * Math.PI) / 180))) * Math.sin(a);
    pts.push([at[1] + dLon, at[0] + dLat]);
  }
  return { type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [pts] } };
}
