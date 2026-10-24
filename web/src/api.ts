// The directory's API, as the website reads it (types as src/read.ts returns them).

export const API = "/directory/api/v1";

export interface SiteView {
  id: string;
  name: string;
  rfss: number | null;
  site: number | null;
  nac: number | null;
  status: "heard" | "announced" | "merged" | "retired";
  modulation: string;
  controlChannelsHz: number[];
  voiceChannelsHz: number[];
  neighbours: string[];
  firstHeard: number | null;
  lastHeard: number | null;
}

export interface SystemView {
  id: string;
  rev: number;
  type: string;
  name: string;
  licensee: string;
  wacn: number | null;
  sysId: number | null;
  status: string;
  mergedInto: string | null;
  createdAt: number;
  updatedAt: number;
  sites: SiteView[];
  licenses: Record<string, { callSign: string; name: string; source: string }>;
  talkgroupCount: number;
}

export interface TalkgroupView {
  id: string;
  number: number;
  alpha: string;
  description: string;
  mode: string;
  tag: string;
  category: string;
  priority: string;
  status: "active" | "heard";
  lastHeard: number | null;
  grants: number;
  encrypted: boolean;
  sites: string[];
  alternatives?: { field: string; value: string; supporters: number }[];
}

export interface SearchHit {
  kind: string;
  systemId: string;
  systemName: string;
  id: string;
  label: string;
}

export interface HistoryEntry {
  rev: number;
  changesetId: string;
  at: number;
  kind: string;
  actorKind: string;
  actor: string;
  note: string;
  revertsId: string | null;
  summary: Record<string, { added: number; changed: number; removed: number }>;
}

export class NotFound extends Error {}

/** GET an API path (a merged system's old ID is redirected to the one it went into). */
export async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (r.status === 404) throw new NotFound();
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
  return r.json();
}

export const mhz = (hz: number) => (hz / 1e6).toFixed(5).replace(/0{1,2}$/, "");
export const hex = (n: number | null) => (n == null ? "—" : n.toString(16).toUpperCase());
export const TYPE: Record<string, string> = { p25: "P25", smartnet: "SmartNet", dmr: "DMR", nxdn: "NXDN", edacs: "EDACS" };

/** A system in a list (src/explore.ts). */
export interface SystemSummary {
  id: string;
  name: string;
  type: string;
  licensee: string;
  sites: number;
  counties: number;
  talkgroupCount: number;
  lastHeard: number | null;
  stale: boolean;
}

export interface NearSystem extends SystemSummary {
  distanceKm: number;
  bearingDeg: number;
  bandMhz: number | null;
  transmitters: { lat: number; lon: number; heightM: number | null; erpW: number | null; freqHz: number | null; callSign: string }[];
}

export interface PlaceHit {
  geoid: string;
  kind: "state" | "county" | "place";
  state: string;
  name: string;
  transmitters: number;
  county: string | null;
}

export interface MapSite {
  site: string;
  system: string;
  name: string;
  licensee: string;
  type: string;
  stale: boolean;
  at: [number, number][];
}

/** A system's name, or who holds its licenses, or that it has neither yet. */
export const nameOf = (s: { name: string; licensee?: string }) => s.name || (s.licensee ? titleCase(s.licensee) : "Unnamed system");

/** FCC licensees are in capitals: "DISTRICT OF COLUMBIA" → "District of Columbia". */
/** Short words that are words, not initials ("CITY OF DOVER", "FIRE"): title-cased; any other short word in capitals is kept ("IPSC", "EMS", "DC"). */
const SHORT_WORDS = new Set(["city", "town", "fire", "park", "lake", "bay", "port", "fort", "new", "east", "west", "north", "south", "area", "mesa", "glen", "hill", "hall", "univ", "dept", "co", "st", "mt", "twp", "rail", "road", "air", "gas", "oil", "post", "farm", "camp", "isle", "key", "keys", "rock", "elk", "oak", "pine", "old", "red", "san", "los", "las", "del", "de", "la", "el", "le", "van", "von", "mc", "mac", "life", "care", "med", "unit", "zone", "base", "home", "bus", "auto"]);
const SMALL = new Set(["of", "and", "the", "for", "in", "on", "at", "to"]);

/** A licensee's name in capitals, as the FCC keeps most, title-cased; a name with lower case already is left as it is. */
export function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s.replace(/[A-Z][A-Z']*/g, (w: string, i: number) => {
    const lower = w.toLowerCase();
    if (i > 0 && SMALL.has(lower)) return lower;
    if (w.length <= 4 && !SMALL.has(lower) && !SHORT_WORDS.has(lower)) return w;
    return w[0] + lower.slice(1);
  });
}

export function ago(t: number | null): string {
  if (!t) return "never";
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString();
}
