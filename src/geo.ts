// Where things are: H3 cells (D1 has no spatial index). A system's region, the
// resolution-3 cell (~12,000 km²) of its licensed towers, scopes the identities
// that repeat across the country (a default WACN, a SmartNet System ID).
// (Where a recorder is is never kept.)

import { cellToParent, gridDisk, latLngToCell } from "h3-js";

export const CELL_RES = 6;
export const REGION_RES = 3;

export const cellOf = (lat: number, lon: number) => latLngToCell(lat, lon, CELL_RES);

/** The region a cell is in (its resolution-3 parent). */
export const regionOf = (cell: string) => cellToParent(cell, REGION_RES);

/** A region and those around it: a weak identity matches across a region's edge. */
export const regionsNear = (region: string) => gridDisk(region, 1);

/** Great-circle distance, km. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}
