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

const LIGHT: Flavor = {
  ...namedFlavor("light"),
  background: "#f4f3f0", earth: "#f4f3f0", water: "#cfdeea",
  boundaries: "#b9bcc4",
  highway: "#ffffff", highway_casing_early: "#d9d5cd", major: "#fbfaf8", major_casing_early: "#e3e0da",
  city_label: "#55595f", city_label_halo: "#f4f3f0", state_label: "#a3a7ae", state_label_halo: "#f4f3f0", country_label: "#9a9ea6", ocean_label: "#7d97b0",
};

const DARK: Flavor = {
  ...namedFlavor("dark"),
  background: "#15181c", earth: "#1b1e22", water: "#202a33",
  boundaries: "#3e4550",
  highway: "#363b42", highway_casing_early: "#15181c", major: "#2b2f35", major_casing_early: "#15181c",
  city_label: "#9aa1aa", city_label_halo: "#15181c", state_label: "#5a616b", state_label_halo: "#15181c", country_label: "#626a75", ocean_label: "#4f6273",
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

