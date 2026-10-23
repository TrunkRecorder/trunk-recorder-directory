// A rough "can I hear it from here?": each transmitter's signal at a point,
// from its licensed power (ERP) and antenna height (the structure's), by the
// Okumura–Hata model for suburban areas (COST-231's extension above 1500 MHz),
// for a scanner antenna 1.5 m up. No terrain: hills, buildings and being
// indoors can take 10–30 dB, so it's an estimate, and the page says so.

export interface Tx {
  lat: number;
  lon: number;
  heightM: number | null;
  erpW: number | null;
  freqHz: number | null;
}

const RX_M = 1.5;
const log10 = Math.log10;

/** Path loss (dB) at `dKm`, `fMhz`, from an antenna `hTx` m up. */
export function pathLossDb(fMhz: number, dKm: number, hTx: number): number {
  const f = Math.min(Math.max(fMhz, 150), 2000);
  const h = Math.min(Math.max(hTx, 10), 300);
  const d = Math.max(dKm, 0.1);
  const a = (1.1 * log10(f) - 0.7) * RX_M - (1.56 * log10(f) - 0.8);
  const urban = (f <= 1500 ? 69.55 + 26.16 * log10(f) : 46.3 + 33.9 * log10(f)) - 13.82 * log10(h) - a + (44.9 - 6.55 * log10(h)) * log10(d);
  return urban - 2 * log10(f / 28) ** 2 - 5.4;
}

/** The radio horizon (km) from an antenna `hTx` m up to the receiver: past it, nothing. */
export const horizonKm = (hTx: number) => 4.12 * (Math.sqrt(Math.max(hTx, 10)) + Math.sqrt(RX_M));

const eirpDbm = (t: Tx) => 10 * log10((t.erpW && t.erpW > 0 ? t.erpW : 100) * 1000) + 2.15;
const height = (t: Tx) => t.heightM && t.heightM > 0 ? t.heightM : 30;
const mhzOf = (t: Tx) => (t.freqHz ?? 851e6) / 1e6;

export function distanceKm(a: [number, number], b: [number, number]): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

/** The signal (dBm) from `t` at `at` ([lat, lon]); -Infinity past its horizon. */
export function receivedDbm(t: Tx, at: [number, number]): number {
  const d = distanceKm(at, [t.lat, t.lon]);
  if (d > horizonKm(height(t))) return -Infinity;
  return eirpDbm(t) - pathLossDb(mhzOf(t), d, height(t));
}

/** How far (km) `t` reaches `dbm` (to its horizon at most). */
export function reachKm(t: Tx, dbm: number): number {
  const h = Math.min(Math.max(height(t), 10), 300);
  const f = mhzOf(t);
  const at1km = eirpDbm(t) - pathLossDb(f, 1, h);
  const slope = 44.9 - 6.55 * log10(h);
  return Math.min(horizonKm(h), 10 ** ((at1km - dbm) / slope));
}

export const LEVELS = [
  { name: "Strong", min: -85 },
  { name: "Good", min: -95 },
  { name: "Fair", min: -105 },
  { name: "Weak", min: -112 },
] as const;

/** A signal's level, by what a scanner or an RTL-SDR usually manages. */
export function level(dbm: number): string {
  return LEVELS.find((l) => dbm >= l.min)?.name ?? "Unlikely";
}

/** A system's best signal at `at`: its strongest transmitter's (simulcast: any of them will do). */
export function best(txs: Tx[], at: [number, number]): number {
  return txs.reduce((m, t) => Math.max(m, receivedDbm(t, at)), -Infinity);
}

/**
 * Where a system would be heard: the best signal of any of its transmitters
 * on a grid around them, as squares by level (only where it's at least weak).
 * Simulcast towers merge into one footprint.
 */
export function coverage(txs: Tx[], cells = 72): { type: "FeatureCollection"; features: { type: "Feature"; properties: { level: string }; geometry: { type: "Polygon"; coordinates: [number, number][][] } }[] } {
  const features: ReturnType<typeof coverage>["features"] = [];
  if (!txs.length) return { type: "FeatureCollection", features };
  const lat0 = txs.reduce((a, t) => a + t.lat, 0) / txs.length;
  const lon0 = txs.reduce((a, t) => a + t.lon, 0) / txs.length;
  const kmLon = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const spread = Math.max(...txs.map((t) => distanceKm([lat0, lon0], [t.lat, t.lon])));
  const half = Math.min(160, spread + Math.max(...txs.map((t) => reachKm(t, LEVELS[3].min))));
  const step = (2 * half) / cells;
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const lat = lat0 - half / 111.32 + ((i + 0.5) * step) / 111.32;
      const lon = lon0 - half / kmLon + ((j + 0.5) * step) / kmLon;
      const l = level(best(txs, [lat, lon]));
      if (l === "Unlikely") continue;
      const dy = step / 2 / 111.32;
      const dx = step / 2 / kmLon;
      features.push({ type: "Feature", properties: { level: l }, geometry: { type: "Polygon", coordinates: [[[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy], [lon - dx, lat - dy]]] } });
    }
  }
  return { type: "FeatureCollection", features };
}
