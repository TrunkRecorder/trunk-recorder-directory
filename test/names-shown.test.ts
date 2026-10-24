// What a system is called when no one has named it: its licensee, title-cased
// as the FCC's capitals are, initials kept (web/src/api.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { nameOf, titleCase } from "../web/src/api.ts";

test("a licensee in capitals: title-cased, its initials kept", () => {
  assert.equal(titleCase("STATE OF INDIANA - IPSC"), "State of Indiana - IPSC");
  assert.equal(titleCase("DISTRICT OF COLUMBIA"), "District of Columbia");
  assert.equal(titleCase("CITY OF DOVER FIRE DEPT"), "City of Dover Fire Dept");
  assert.equal(titleCase("MADISON, COUNTY OF"), "Madison, County of");
  assert.equal(titleCase("ARLINGTON COUNTY ECC"), "Arlington County ECC");
  assert.equal(titleCase("DC FIRE AND EMS"), "DC Fire and EMS");
  assert.equal(titleCase("O'HARE AIRPORT"), "O'hare Airport");
  // Lower case already: as it is.
  assert.equal(titleCase("Washington Metropolitan Area Transit Authority"), "Washington Metropolitan Area Transit Authority");
});

test("a system's name: its own, else its licensee's", () => {
  assert.equal(nameOf({ name: "DC Fire", licensee: "DISTRICT OF COLUMBIA" }), "DC Fire");
  assert.equal(nameOf({ name: "", licensee: "STATE OF INDIANA - IPSC" }), "State of Indiana - IPSC");
  assert.equal(nameOf({ name: "" }), "Unnamed system");
});
