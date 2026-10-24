// Planning SDRs for a system: the fewest windows, by TRP's rules.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Channel, counts, DEVICES, optimize, planSdrs, ratesOf, usableHalfWidth } from "../src/sdrplan.ts";

const dev = (k: string) => DEVICES.find((d) => d.key === k)!;
const ch = (mhz: number[], kind: Channel["kind"] = "voice"): Channel[] => mhz.map((m) => ({ hz: Math.round(m * 1e6), kind }));

/** Every channel in exactly one window, inside its usable part and off its centre. */
function holds(p: ReturnType<typeof planSdrs>, all: Channel[]) {
  const seen = p.windows.flatMap((w) => w.channels.map((c) => c.hz));
  assert.equal(new Set(seen).size, seen.length, "each once");
  assert.equal(seen.length + p.outOfRange.length, new Set(all.map((c) => c.hz)).size);
  for (const w of p.windows) {
    assert.equal(w.centerHz % 1000, 0, "a 1 kHz grid");
    for (const c of w.channels) {
      assert.ok(c.hz >= w.lowHz + 10_000 && c.hz <= w.highHz - 10_000, `${c.hz} inside ${w.lowHz}–${w.highHz}`);
      if (!w.nearDc) assert.ok(Math.abs(c.hz - w.centerHz) >= 25_000, `${c.hz} off DC at ${w.centerHz}`);
    }
  }
}

test("usable half-width is TRP's: rate/2 less the 75 kHz guard, never under rate/4", () => {
  assert.equal(usableHalfWidth(2_400_000), 1_125_000);
  assert.equal(usableHalfWidth(10_000_000), 4_925_000);
  assert.equal(usableHalfWidth(200_000), 50_000);
});

test("a site within 2 MHz: one RTL-SDR, its centre between them and off DC", () => {
  const site = [...ch([857.9875, 856.0125], "control"), ...ch([856.2375, 856.7375, 857.2375, 857.4875])];
  const p = planSdrs(site, dev("rtlsdr"));
  assert.equal(p.windows.length, 1);
  holds(p, site);
  assert.equal(p.windows[0].channels.filter((c) => c.kind === "control").length, 2);
});

test("a system across 851–860 MHz: several RTL-SDRs, one Airspy R2; each channel held once", () => {
  const sys = [...ch([851.0125, 853.4125, 856.2375, 859.9875], "control"), ...ch(Array.from({ length: 30 }, (_, i) => 851.1 + i * 0.3))];
  const rtl = planSdrs(sys, dev("rtlsdr"));
  assert.ok(rtl.windows.length >= 4, String(rtl.windows.length));
  holds(rtl, sys);
  const airspy = planSdrs(sys, dev("airspy"));
  assert.equal(airspy.windows.length, 1);
  holds(airspy, sys);
  // Faster is fewer.
  assert.ok(planSdrs(sys, dev("rtlsdr"), 3_200_000).windows.length <= rtl.windows.length);
  assert.deepEqual(counts(sys).find((c) => c.device.key === "usrp")!.count, 1);
});

test("700 and 800 MHz in one system: a window each, not one across the gap", () => {
  const sys = [...ch([770.10625, 771.35625]), ...ch([851.5125], "control")];
  const p = planSdrs(sys, dev("hackrf"));
  assert.equal(p.windows.length, 2);
  holds(p, sys);
});

test("what a device can't tune is said, not planned; a frequency both control and voice is a control channel", () => {
  const sys = [...ch([1_900], "voice"), ...ch([855.4625], "control"), ...ch([855.4625])];
  const p = planSdrs(sys, dev("rtlsdr"));
  assert.deepEqual(p.outOfRange.map((c) => c.hz), [1_900_000_000]);
  assert.equal(p.windows.length, 1);
  assert.equal(p.windows[0].channels[0].kind, "control");
  assert.deepEqual(planSdrs([], dev("rtlsdr")).windows, []);
});

test("2.5 MHz of channels is more than an RTL-SDR at 2.4 MS/s holds (2.23 MHz usable): two", () => {
  const site = ch([855.4625, 857.9875], "control");
  assert.equal(planSdrs(site, dev("rtlsdr")).windows.length, 2);
  assert.equal(planSdrs(site, dev("rtlsdr"), 3_200_000).windows.length, 1);
});

const wmata = [...ch([490.7875, 490.8625, 496.4375, 496.5375], "control"), ...ch([490.7625, 490.8375, 490.8875, 490.9125, 496.4625, 496.5875, 496.6125])];

test("optimized: the fewest devices, each at the lowest rate of its class that holds its channels", () => {
  // Two clusters 6 MHz apart: two RTL-SDRs, each needing only a little of its band.
  const rtl = optimize(wmata, dev("rtlsdr"));
  assert.equal(rtl.windows.length, 2);
  holds(rtl, wmata);
  assert.ok(rtl.windows.every((w) => w.rateHz === 1_024_000), rtl.windows.map((w) => w.rateHz).join());
  // One Airspy R2 must span both: its 10 MS/s, not 2.5.
  const airspy = optimize(wmata, dev("airspy"));
  assert.equal(airspy.windows.length, 1);
  assert.equal(airspy.windows[0].rateHz, 10_000_000);
  // A HackRF needs about 6 MHz: 8 MS/s, the lowest of its rates that holds it.
  const hack = optimize(wmata, dev("hackrf"));
  assert.equal(hack.windows.length, 1);
  assert.equal(hack.windows[0].rateHz, 8_000_000);
  holds(hack, wmata);
});

test("optimized never takes more devices than any one rate of its class; faster, less reliable rates only when asked", () => {
  const site = ch([855.4625, 857.9875], "control");
  assert.equal(optimize(site, dev("rtlsdr")).windows.length, 2, "2.5 MHz: two at 2.4 MS/s or less");
  const pushed = optimize(site, dev("rtlsdr"), { stretch: true });
  assert.equal(pushed.windows.length, 1);
  assert.equal(pushed.windows[0].rateHz, 2_880_000, "the lowest of the faster rates that holds it");
  const sys = [...ch([851.0125, 853.4125, 856.2375, 859.9875], "control"), ...ch(Array.from({ length: 30 }, (_, i) => 851.1 + i * 0.3))];
  for (const d of DEVICES) {
    const best = optimize(sys, d).windows.length;
    for (const r of ratesOf(d)) assert.ok(best <= planSdrs(sys, d, r).windows.length, `${d.key} at ${r}`);
    holds(optimize(sys, d), sys);
  }
  assert.deepEqual(counts(wmata).map((c) => [c.device.key, c.count]), [["rtlsdr", 2], ["airspy", 1], ["airspy-mini", 2], ["hackrf", 1], ["usrp", 1]]);
});
