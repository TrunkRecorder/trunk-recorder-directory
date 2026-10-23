// The basemap's style for this site's maps (src/mapstyle.ts, here).
import type { StyleSpecification } from "maplibre-gl";
import { basemapStyle as style } from "../../src/mapstyle.ts";

export const basemapStyle = (theme: "light" | "dark"): StyleSpecification => style(theme, location.origin);
