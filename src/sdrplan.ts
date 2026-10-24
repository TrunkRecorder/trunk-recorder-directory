// How many SDRs a system takes, and where each is tuned: the fewest windows
// of a device's usable bandwidth that hold every channel of the sites chosen.
// The rules are Trunk Recorder Pro's, so a plan here is one TRP accepts:
//   - usable half-width: max(rate/2 − guard, rate/4), guard 75 kHz
//     (trunk-core engine.rs usable_half_width, DEFAULT_GUARD_HZ);
//   - a channel at least 10 kHz inside that edge, and at least 25 kHz from
//     the centre's DC spike (trunk-app config.rs auto_center / off_dc);
//   - centres on a 1 kHz grid.
// The site and the directory API don't run TRP's code, so these few
// constants are mirrored here; keep them in step.

export const GUARD_HZ = 75_000;
const EDGE_HZ = 10_000;
const DC_CLEAR_HZ = 25_000;
const DC_STEP_HZ = 12_500;
const DC_TRIES = 40;

export interface Device {
  key: string;
  name: string;
  /** Sample rates it runs at reliably (S/s), lowest first. */
  rates: number[];
  /** Faster ones it can run at, less reliably (an RTL-SDR above 2.4 MS/s drops samples on many hosts). */
  stretch: number[];
  /** The rate to start from when one is chosen by hand. */
  usual: number;
  /** What it tunes, Hz. */
  minHz: number;
  maxHz: number;
  /** A line about its rates. */
  note: string;
}

/** The devices TRP records with, and the rates each class runs at. */
export const DEVICES: Device[] = [
  { key: "rtlsdr", name: "RTL-SDR", rates: [1_024_000, 1_400_000, 1_800_000, 1_920_000, 2_048_000, 2_400_000], stretch: [2_560_000, 2_880_000, 3_200_000], usual: 2_400_000, minHz: 24e6, maxHz: 1_766e6, note: "Up to 2.4 MS/s reliably; 2.56–3.2 drop samples on many computers." },
  { key: "airspy", name: "Airspy R2", rates: [2_500_000, 10_000_000], stretch: [], usual: 10_000_000, minHz: 24e6, maxHz: 1_800e6, note: "2.5 or 10 MS/s." },
  { key: "airspy-mini", name: "Airspy Mini", rates: [3_000_000, 6_000_000], stretch: [10_000_000], usual: 6_000_000, minHz: 24e6, maxHz: 1_800e6, note: "3 or 6 MS/s; 10 with newer firmware." },
  { key: "hackrf", name: "HackRF One", rates: [2_000_000, 4_000_000, 8_000_000, 10_000_000, 12_500_000, 16_000_000, 20_000_000], stretch: [], usual: 10_000_000, minHz: 1e6, maxHz: 6_000e6, note: "2–20 MS/s, through SoapySDR; above 10 needs a fast USB port and CPU." },
  { key: "usrp", name: "Ettus USRP (B200/B210)", rates: [2_400_000, 4_000_000, 5_000_000, 6_400_000, 8_000_000, 10_000_000, 12_500_000, 16_000_000, 20_000_000, 32_000_000, 56_000_000], stretch: [], usual: 20_000_000, minHz: 70e6, maxHz: 6_000e6, note: "Up to 56 MS/s over USB 3." },
];

/** The rates the optimizer may use: its reliable ones, and its faster ones if `stretch`. */
export const ratesOf = (d: Device, stretch = false) => [...d.rates, ...(stretch ? d.stretch : [])].sort((a, b) => a - b);

/** Half the band a device at `rateHz` records well, Hz. */
export const usableHalfWidth = (rateHz: number, guardHz = GUARD_HZ) => Math.max(rateHz / 2 - Math.max(guardHz, 0), rateHz / 4);

export interface Channel {
  hz: number;
  kind: "control" | "voice";
}

export interface Window {
  centerHz: number;
  rateHz: number;
  /** The part it records well: centre ± usable half-width. */
  lowHz: number;
  highHz: number;
  channels: Channel[];
  /** A channel it holds is nearer its centre than DC_CLEAR_HZ (no centre clears them all). */
  nearDc: boolean;
}

export interface Plan {
  device: Device;
  /** The rate it was planned at (optimize: the top; each window says its own). */
  rateHz: number;
  windows: Window[];
  /** Channels it can't tune. */
  outOfRange: Channel[];
}

const round1k = (hz: number) => Math.round(hz / 1000) * 1000;

/** A centre that holds `hzs` within `reach` of it and keeps them off DC: from `mid`, alternate ±12.5 kHz steps. */
function offDc(mid: number, hzs: number[], reach: number): { center: number; nearDc: boolean } {
  const fits = (c: number) => hzs.every((f) => Math.abs(f - c) <= reach);
  const clear = (c: number) => hzs.every((f) => Math.abs(f - c) >= DC_CLEAR_HZ);
  for (let i = 0; i <= DC_TRIES; i++) {
    const c = round1k(mid + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * DC_STEP_HZ);
    if (fits(c) && clear(c)) return { center: c, nearDc: false };
  }
  return { center: round1k(mid), nearDc: true };
}

/** The fewest windows of `device` at `rateHz` that hold every channel (greedy from the lowest: the fewest there are). */
export function planSdrs(channels: Channel[], device: Device, rateHz = device.usual, guardHz = GUARD_HZ): Plan {
  const byHz = new Map<number, Channel>();
  // A frequency that is both is a control channel.
  for (const c of channels) if (!byHz.has(c.hz) || c.kind === "control") byHz.set(c.hz, c);
  const all = [...byHz.values()].sort((a, b) => a.hz - b.hz);
  const outOfRange = all.filter((c) => c.hz < device.minHz || c.hz > device.maxHz);
  const todo = all.filter((c) => !outOfRange.includes(c));
  const half = usableHalfWidth(rateHz, guardHz);
  const reach = half - EDGE_HZ;
  const windows: Window[] = [];
  for (let i = 0; i < todo.length; ) {
    // From the lowest left, as far up as one window reaches; leave room to step off DC.
    let j = i;
    while (j + 1 < todo.length && todo[j + 1].hz - todo[i].hz <= 2 * reach - 2 * DC_STEP_HZ) j++;
    const held = todo.slice(i, j + 1);
    const hzs = held.map((c) => c.hz);
    const { center, nearDc } = offDc((hzs[0] + hzs[hzs.length - 1]) / 2, hzs, reach);
    windows.push({ centerHz: center, rateHz, lowHz: center - half, highHz: center + half, channels: held, nearDc });
    i = j + 1;
  }
  return { device, rateHz, windows, outOfRange };
}

/**
 * The fewest devices, then each at the lowest rate that holds its channels:
 * planned at the class's top rate (no rate takes fewer), then each window
 * slowed to the lowest rate that still holds what it has, off DC (less CPU
 * and USB, and less to keep up with).
 */
export function optimize(channels: Channel[], device: Device, opts: { stretch?: boolean; guardHz?: number } = {}): Plan {
  const rates = ratesOf(device, opts.stretch);
  const top = planSdrs(channels, device, rates[rates.length - 1], opts.guardHz);
  const windows = top.windows.map((w) => {
    for (const r of rates) {
      const one = planSdrs(w.channels, device, r, opts.guardHz);
      if (one.windows.length === 1 && !one.windows[0].nearDc) return one.windows[0];
    }
    return w;
  });
  return { ...top, windows };
}

/** How many of each device the optimizer takes: the choice at a glance. */
export function counts(channels: Channel[], stretch = false): { device: Device; count: number }[] {
  return DEVICES.map((d) => ({ device: d, count: optimize(channels, d, { stretch }).windows.length }));
}
