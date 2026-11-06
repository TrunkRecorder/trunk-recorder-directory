// What the air says, as keys that point at records (claims). The air's
// identities aren't unique enough to be IDs: WACN BEE00 is a common default,
// and SmartNet, DMR and NXDN system codes repeat across the country. So a weak
// identity is scoped to a region (an H3 resolution-3 cell: where the system's
// licensed towers are, never where a recorder is), and matched across that
// region and the ones around it. An FCC call sign is strong and nationwide.
// docs/design.md, "Identifiers".

import { regionsNear } from "./geo.ts";
import type { SiteIdentity } from "./observation.ts";

export const DEFAULT_WACN = 0xbee00;

const hex = (n: number) => n.toString(16);
const raster = (hz: number) => Math.round(hz / 6250) * 6250;

/** A claim key as stored: unscoped, or scoped to a region (`…@region`). */
export interface ClaimKeys {
  /** Stored for the record. */
  store: string[];
  /** Looked up (a scoped claim: in the region and those around it). */
  lookup: string[];
  /** A match on it is enough by itself. */
  strong: boolean;
}

function keys(base: string, region: string | null, scoped: boolean, strong: boolean): ClaimKeys | null {
  if (!scoped) return { store: [base], lookup: [base], strong };
  // A weak identity without a region can't be told from another's: not a claim.
  if (!region) return null;
  return { store: [`${base}@${region}`], lookup: regionsNear(region).map((r) => `${base}@${r}`), strong };
}

/** A system's claim, from what a site says. */
export function systemClaim(type: string, id: SiteIdentity, region: string | null): ClaimKeys | null {
  if (type === "p25" && id.sysId != null && id.wacn != null) {
    return keys(`p25:${hex(id.wacn)}.${hex(id.sysId)}`, region, id.wacn === DEFAULT_WACN, true);
  }
  if (type === "smartnet" && id.sysId != null) return keys(`smartnet:${hex(id.sysId)}`, region, true, true);
  return null;
}

/** A site's claims: its identity in the system, and its control channels in the region. */
export function siteClaims(type: string, id: SiteIdentity, controlChannelsHz: number[], region: string | null): ClaimKeys[] {
  const out: ClaimKeys[] = [];
  const sys = systemClaim(type, id, region);
  if (sys && type === "p25" && id.rfss != null && id.site != null) {
    out.push({ store: sys.store.map((k) => `${k}/${id.rfss}.${id.site}`), lookup: sys.lookup.map((k) => `${k}/${id.rfss}.${id.site}`), strong: true });
  }
  for (const f of controlChannelsHz) {
    const c = keys(`cc:${type}:${raster(f)}`, region, true, false);
    if (c) out.push(c);
  }
  return out;
}

/** A neighbour as an identity: its WACN and SysID if it says them, else the announcing site's. */
export const neighbourId = (id: SiteIdentity, n: { wacn?: number | null; sysId?: number | null; rfss: number; site: number }): SiteIdentity => ({
  wacn: n.wacn ?? id.wacn,
  sysId: n.sysId ?? id.sysId,
  rfss: n.rfss,
  site: n.site,
});

/**
 * A neighbour of the announcing site's own system, not a neighbouring
 * system's: the same SysID, and the same WACN where both have one (NXDN's
 * sites have none).
 */
export function ownNeighbour(id: SiteIdentity, n: { wacn?: number | null; sysId?: number | null; rfss: number; site: number }): boolean {
  const m = neighbourId(id, n);
  return m.sysId === id.sysId && (id.wacn == null || m.wacn === id.wacn);
}

/** A neighbour a site announces, as its site claim (P25: under its own WACN and SysID, the announcing site's unless it says them). */
export function neighbourClaim(type: string, id: SiteIdentity, n: { wacn?: number | null; sysId?: number | null; rfss: number; site: number }, region: string | null): ClaimKeys | null {
  if (type !== "p25") return null;
  const sys = systemClaim(type, neighbourId(id, n), region);
  return sys && { store: sys.store.map((k) => `${k}/${n.rfss}.${n.site}`), lookup: sys.lookup.map((k) => `${k}/${n.rfss}.${n.site}`), strong: true };
}

/**
 * A system's FCC call sign as a claim: strong, and nationwide (a call sign is
 * one licensee's, wherever it's heard), of its type (a licensee can run a P25
 * and an analog system on one license).
 */
export function callSignClaim(type: string, callSign: string): ClaimKeys | null {
  const c = callSign.trim().toUpperCase();
  return /^[A-Z0-9]{3,8}$/.test(c) ? keys(`fcc:${type}:${c}`, null, false, true) : null;
}
