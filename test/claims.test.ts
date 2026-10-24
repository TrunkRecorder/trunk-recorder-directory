// Identity claims, and where things are.

import assert from "node:assert/strict";
import { test } from "node:test";
import { callSignClaim, DEFAULT_WACN, neighbourClaim, siteClaims, systemClaim } from "../src/claims.ts";
import { cellOf, distanceKm, regionOf, regionsNear } from "../src/geo.ts";
import { DC, DENVER } from "./helpers.ts";

const region = regionOf(DC);

test("a P25 identity with its own WACN is unique enough: not scoped", () => {
  const c = systemClaim("p25", { wacn: 0xbee01, sysId: 0x3a9 }, region)!;
  assert.deepEqual(c.store, ["p25:bee01.3a9"]);
  assert.deepEqual(c.lookup, ["p25:bee01.3a9"]);
  assert.equal(c.strong, true);
  assert.deepEqual(systemClaim("p25", { wacn: 0xbee01, sysId: 0x3a9 }, null)!.store, ["p25:bee01.3a9"], "no region needed");
});

test("the default WACN, SmartNet and others are scoped to a region, and looked up across its neighbours", () => {
  const c = systemClaim("p25", { wacn: DEFAULT_WACN, sysId: 0x1a2 }, region)!;
  assert.deepEqual(c.store, [`p25:bee00.1a2@${region}`]);
  assert.equal(c.lookup.length, 7);
  assert.ok(c.lookup.includes(`p25:bee00.1a2@${region}`));
  assert.equal(systemClaim("p25", { wacn: DEFAULT_WACN, sysId: 0x1a2 }, null), null, "no region: no claim");
  assert.deepEqual(systemClaim("smartnet", { sysId: 0xbeef }, region)!.store, [`smartnet:beef@${region}`]);
  assert.equal(systemClaim("dmr", { sysId: 1 }, region), null);
  assert.equal(systemClaim("p25", { sysId: 1 }, region), null, "no WACN: no system claim");
});

test("a site's claims: its identity under the system's, and each control channel on the raster in the region", () => {
  const cs = siteClaims("p25", { wacn: 0xbee01, sysId: 0x3a9, rfss: 1, site: 5 }, [857_987_600, 858_987_500], region);
  assert.deepEqual(cs[0].store, ["p25:bee01.3a9/1.5"]);
  assert.equal(cs[0].strong, true);
  assert.deepEqual(cs.slice(1).map((c) => c.store[0]), [`cc:p25:857987500@${region}`, `cc:p25:858987500@${region}`]);
  assert.ok(cs.slice(1).every((c) => !c.strong));
  assert.deepEqual(siteClaims("p25", { wacn: 0xbee01, sysId: 0x3a9 }, [851e6], null), [], "no region, no site number: nothing to match");
});

test("a neighbour's claim is under the announcing site's system (its own SysID if it says one)", () => {
  const id = { wacn: 0xbee01, sysId: 0x3a9, rfss: 1, site: 1 };
  assert.deepEqual(neighbourClaim("p25", id, { rfss: 1, site: 2 }, region)!.store, ["p25:bee01.3a9/1.2"]);
  assert.deepEqual(neighbourClaim("p25", id, { sysId: 0x3aa, rfss: 1, site: 2 }, region)!.store, ["p25:bee01.3aa/1.2"]);
  assert.equal(neighbourClaim("smartnet", id, { rfss: 1, site: 2 }, region), null);
});

test("regions (where a system's towers are) and distances", () => {
  assert.equal(cellOf(38.9, -77.03), DC);
  assert.equal(regionsNear(region).length, 7);
  assert.notEqual(regionOf(DC), regionOf(DENVER));
  const d = distanceKm([38.9, -77.03], [39.74, -104.99]);
  assert.ok(d > 2390 && d < 2420, `${d}`);
});

test("an FCC call sign is a strong claim, nationwide, of its type", () => {
  const c = callSignClaim("p25", " wpxt459 ")!;
  assert.deepEqual(c, { store: ["fcc:p25:WPXT459"], lookup: ["fcc:p25:WPXT459"], strong: true });
  assert.notDeepEqual(callSignClaim("smartnet", "WPXT459"), c, "the same license's other system isn't it");
  assert.equal(callSignClaim("p25", "not a sign"), null);
});
