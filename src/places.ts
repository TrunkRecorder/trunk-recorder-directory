// Which county and city (Census place) a point is in: each state's boundaries
// (scripts/geo.ts makes them from the Census Bureau's files), read as needed
// and kept, and a point-in-polygon test. The Worker reads them from its own
// assets (/directory/geo/states/<ST>.json); tests and the dev server from files.

type Ring = [number, number][];
type Polygon = Ring[];

interface Shape {
  kind: "county" | "place";
  geoid: string;
  name: string;
  /** Its polygons, and their bounding box (west, south, east, north). */
  polygons: Polygon[];
  bbox: [number, number, number, number];
}

/** Reads a state's boundaries (GeoJSON text), or null when there are none. */
export type GeoSource = (state: string) => Promise<string | null>;

export interface Where {
  state: string;
  county: string;
  place: string;
}

function bboxOf(polys: Polygon[]): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polys) for (const [x, y] of p[0]) [w, s, e, n] = [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)];
  return [w, s, e, n];
}

/** Ray casting: inside its outer ring and none of its holes. */
function inRing(r: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (p: Polygon, x: number, y: number) => inRing(p[0], x, y) && !p.slice(1).some((h) => inRing(h, x, y));

export class Places {
  private states = new Map<string, Promise<Shape[] | null>>();
  private source: GeoSource;
  constructor(source: GeoSource) {
    this.source = source;
  }

  private load(state: string): Promise<Shape[] | null> {
    let p = this.states.get(state);
    if (!p) {
      p = this.source(state).then((text) => {
        if (!text) return null;
        const fc = JSON.parse(text) as { features: { properties: { kind: "county" | "place"; geoid: string; name: string }; geometry: { type: string; coordinates: unknown } }[] };
        return fc.features.map((f) => {
          const polygons = (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates]) as Polygon[];
          return { kind: f.properties.kind, geoid: f.properties.geoid, name: f.properties.name, polygons, bbox: bboxOf(polygons) };
        });
      }).catch(() => null);
      this.states.set(state, p);
    }
    return p;
  }

  /** The county and place at a point in `state` (USPS code, as the FCC license says). Empty when outside them, or the state's boundaries aren't there. */
  async at(state: string, lat: number, lon: number): Promise<Where> {
    const out: Where = { state: state.toUpperCase(), county: "", place: "" };
    const shapes = state ? await this.load(out.state) : null;
    if (!shapes) return out;
    for (const s of shapes) {
      if (out[s.kind]) continue;
      const [w, so, e, n] = s.bbox;
      if (lon < w || lon > e || lat < so || lat > n) continue;
      if (s.polygons.some((p) => inPolygon(p, lon, lat))) out[s.kind] = s.geoid;
      if (out.county && out.place) break;
    }
    return out;
  }
}
