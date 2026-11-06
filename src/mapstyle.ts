// The basemap's style: Protomaps' layers over the directory's own vector tiles
// (/directory/tiles), cut down to what helps find a radio system — land and
// water, state lines, main roads, towns — in a light and a dark palette. The
// fonts are the directory's own too (/directory/fonts); nothing is asked of
// another site. The site's maps use it, and the Worker serves it as
// /directory/map/style-{light,dark}.json for other apps' maps (Trunk Recorder
// Pro's location picker).

import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

/** Protomaps' layers kept (no buildings, land use, minor roads, transit or points of interest). */
const KEEP = new Set([
  "background", "earth", "water", "water_river",
  "roads_major_casing_early", "roads_major", "roads_highway_casing_early", "roads_highway",
  "boundaries_country", "boundaries",
  "water_label_ocean", "water_label_lakes", "places_region", "places_locality", "places_country",
]);

// (Cool greys and the night blue of trunkrecorder.pro's pages, so the map sits in them.)
const LIGHT: Flavor = {
  ...namedFlavor("light"),
  background: "#f3f6fa", earth: "#f3f6fa", water: "#cfe0ef",
  boundaries: "#b4bfcd",
  highway: "#ffffff", highway_casing_early: "#d5dde8", major: "#fbfcfe", major_casing_early: "#e3e8ef",
  city_label: "#4b5b70", city_label_halo: "#f3f6fa", state_label: "#9aa8ba", state_label_halo: "#f3f6fa", country_label: "#93a1b4", ocean_label: "#6f8fae",
};

const DARK: Flavor = {
  ...namedFlavor("dark"),
  background: "#0b1220", earth: "#111a2a", water: "#0c1d33",
  boundaries: "#2f3e59",
  highway: "#26344d", highway_casing_early: "#0b1220", major: "#1c2840", major_casing_early: "#0b1220",
  city_label: "#8fa0b8", city_label_halo: "#0b1220", state_label: "#4f6280", state_label_halo: "#0b1220", country_label: "#5a6c88", ocean_label: "#40597a",
};

/** A layer without its icons (there's no sprite sheet: town names stand alone). */
function withoutIcons(l: LayerSpecification): LayerSpecification {
  if (l.type !== "symbol" || !l.layout) return l;
  const layout = Object.fromEntries(Object.entries(l.layout).filter(([k]) => !k.startsWith("icon-")));
  return { ...l, layout } as LayerSpecification;
}

/** The style, its tiles and fonts at `origin` (where the directory is). */
export function basemapStyle(theme: "light" | "dark", origin: string): StyleSpecification {
  return {
    version: 8,
    glyphs: `${origin}/directory/fonts/{fontstack}/{range}.pbf`,
    sources: {
      protomaps: {
        type: "vector",
        tiles: [`${origin}/directory/tiles/{z}/{x}/{y}.mvt`],
        maxzoom: 12,
        attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
      },
    },
    layers: (layers("protomaps", theme === "dark" ? DARK : LIGHT, { lang: "en" }) as LayerSpecification[]).filter((l) => KEEP.has(l.id)).map(withoutIcons),
  };
}

