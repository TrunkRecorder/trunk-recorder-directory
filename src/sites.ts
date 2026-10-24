// When two site records are one site: the one rule a share's matching, a
// system merge and a system's own twin sites all use.
//
// A site number says which site it is: two with numbers (P25 RFSS and site;
// SmartNet, DMR and NXDN site) are one site when they're equal and two when
// they aren't, whatever their channels. Without one on either, a control
// channel in common makes them one (a site's control channels are its own).

export interface SiteKey {
  rfss: number | null;
  site: number | null;
  /** Its control channels, Hz. */
  controlHz: number[];
}

const raster = (hz: number) => Math.round(hz / 6250) * 6250;

export function sameSite(a: SiteKey, b: SiteKey): boolean {
  if (a.site != null && b.site != null) return a.site === b.site && (a.rfss ?? null) === (b.rfss ?? null);
  const cc = new Set(a.controlHz.map(raster));
  return b.controlHz.some((f) => cc.has(raster(f)));
}
