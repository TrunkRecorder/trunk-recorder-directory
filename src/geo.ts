// Where things are, by H3 cell (D1 has no spatial index): resolution 6
// (~36 km²) for a recorder's place and for coverage, resolution 3 (~12,000
// km²) for the region a weak identity is scoped to.

import { cellToLatLng, cellToParent, getResolution, gridDisk, isValidCell, latLngToCell } from "h3-js";

export const CELL_RES = 6;
export const REGION_RES = 3;

/** A recorder's cell, if it's a resolution-6 H3 cell. */
export function validCell(c: string | null | undefined): string | null {
  return c && isValidCell(c) && getResolution(c) === CELL_RES ? c : null;
}

export const cellOf = (lat: number, lon: number) => latLngToCell(lat, lon, CELL_RES);
export const cellCenter = (c: string) => cellToLatLng(c);

/** The region a cell is in (its resolution-3 parent). */
export const regionOf = (cell: string) => cellToParent(cell, REGION_RES);

/** A region and those around it: a weak identity matches across a region's edge. */
export const regionsNear = (region: string) => gridDisk(region, 1);

/** The cells within `radiusKm` of a cell (resolution 6 cells are ~6.5 km across). */
export function cellsWithin(cell: string, radiusKm: number): string[] {
  const k = Math.max(0, Math.min(40, Math.ceil(radiusKm / 6.5)));
  return gridDisk(cell, k);
}

/** Great-circle distance, km. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}
