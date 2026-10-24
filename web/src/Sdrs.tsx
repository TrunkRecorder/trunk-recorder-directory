// How many SDRs a system takes, and where each is tuned (src/sdrplan.ts, by
// Trunk Recorder Pro's rules): for the device and rate chosen, and the sites
// chosen (a recorder follows one site; a simulcast site is one), optimized
// (the fewest devices, each at the lowest rate that holds its channels) or at
// one rate, a band plan
// of each device's span over the channels it holds, and a table of each.

import { useMemo, useState } from "react";
import { counts, DEVICES, optimize, planSdrs, ratesOf, type Channel, type Window } from "../../src/sdrplan.ts";
import { mhz, type SystemView } from "./api.ts";

/** Each device's colour, by its place in the plan. */
const COLORS = ["#2f7ff5", "#e08a1e", "#1f9e74", "#d2457a", "#8e5bd6", "#c2a400", "#0fa3b1", "#e4572e"];
export const sdrColor = (i: number) => COLORS[i % COLORS.length];

const msps = (r: number) => `${(r / 1e6).toLocaleString(undefined, { maximumFractionDigits: 3 })} MS/s`;
const siteName = (s: SystemView["sites"][number]) => (s.rfss != null ? `${s.rfss}-${s.site}` : s.name || "site");
/** Frequency ranges this far apart are drawn apart (700 and 800 MHz in one system). */
const BAND_GAP_HZ = 20e6;

export function SdrPlanner(props: { sys: SystemView }) {
  const heard = props.sys.sites.filter((s) => s.status === "heard" && s.controlChannelsHz.length);
  const choosable = heard.length ? heard : props.sys.sites.filter((s) => s.controlChannelsHz.length);
  const [sites, setSites] = useState<string[]>(() => choosable.slice(0, 1).map((s) => s.id));
  const [deviceKey, setDeviceKey] = useState("rtlsdr");
  const device = DEVICES.find((d) => d.key === deviceKey) ?? DEVICES[0];
  // 0: optimized (the fewest devices, each at the lowest rate that holds its channels); else one rate for all.
  const [rateHz, setRateHz] = useState(0);
  const [stretch, setStretch] = useState(false);
  const offered = ratesOf(device, stretch);
  const rate = offered.includes(rateHz) ? rateHz : 0;

  const channels = useMemo<Channel[]>(
    () =>
      props.sys.sites
        .filter((s) => sites.includes(s.id))
        .flatMap((s) => [...s.controlChannelsHz.map((hz) => ({ hz, kind: "control" as const })), ...s.voiceChannelsHz.map((hz) => ({ hz, kind: "voice" as const }))]),
    [props.sys, sites],
  );
  const plan = useMemo(() => (rate ? planSdrs(channels, device, rate) : optimize(channels, device, { stretch })), [channels, device, rate, stretch]);
  const others = useMemo(() => counts(channels, stretch), [channels, stretch]);
  const used = [...new Set(plan.windows.map((w) => w.rateHz))].sort((a, b) => a - b);
  const voice = new Set(channels.filter((c) => c.kind === "voice").map((c) => c.hz)).size;

  if (!choosable.length) return <p className="muted">No control channels known yet, so there's nothing to plan.</p>;
  return (
    <div className="stack sdr-plan">
      <p className="muted small">
        How many SDRs it takes to record every channel of the sites you choose, and where to tune each. A recorder follows one site at a time (a simulcast site is
        one), so choose the site you can receive. By Trunk Recorder Pro's rules: each device records its sample rate less a 75 kHz guard at each edge, and no
        channel sits on its centre.
      </p>
      <div className="stack">
        <div className="chips" role="radiogroup" aria-label="SDR">
          {others.map(({ device: d, count }) => (
            <button key={d.key} role="radio" aria-checked={d.key === device.key} className={`chip${d.key === device.key ? " on" : ""}`} onClick={() => setDeviceKey(d.key)}>
              {d.name}
              {channels.length > 0 && <span className="muted">× {count}</span>}
            </button>
          ))}
        </div>
        <div className="row">
          <label className="small">
            Sample rate{" "}
            <select value={rate} onChange={(e) => setRateHz(Number(e.target.value))}>
              <option value={0}>Optimized: fewest devices, each as slow as it can be</option>
              {offered.map((r) => (
                <option key={r} value={r}>
                  {msps(r)} for every one{device.stretch.includes(r) ? " (a faster rate)" : ""}
                </option>
              ))}
            </select>
          </label>
          {device.stretch.length > 0 && (
            <label className="toggle small">
              <input type="checkbox" checked={stretch} onChange={(e) => setStretch(e.target.checked)} /> Also its faster rates ({device.stretch.map(msps).join(", ")})
            </label>
          )}
          <span className="muted small">{device.note}</span>
        </div>
        {choosable.length > 1 && (
          <fieldset className="stack sdr-sites">
            <legend className="small muted">Sites</legend>
            <div className="chips">
              {choosable.map((s) => (
                <label key={s.id} className={`chip${sites.includes(s.id) ? " on" : ""}`}>
                  <input type="checkbox" checked={sites.includes(s.id)} onChange={(e) => setSites(e.target.checked ? [...sites, s.id] : sites.filter((x) => x !== s.id))} />
                  {siteName(s)} <span className="muted mono">{s.controlChannelsHz.map(mhz).slice(0, 2).join(", ")}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>

      {!channels.length ? (
        <p className="muted">Choose a site.</p>
      ) : (
        <>
          <div className="sdr-summary">
            <b className="sdr-count">
              {plan.windows.length} × {device.name}
            </b>
            <span className="muted">
              at {used.map(msps).join(" and ")}
              {!rate && used.length > 0 && ` (the lowest that holds ${plan.windows.length === 1 ? "its" : "each one's"} channels)`} for {new Set(channels.filter((c) => c.kind === "control").map((c) => c.hz)).size} control and {voice} voice channel{voice === 1 ? "" : "s"}
              {voice === 0 && " (no voice channels heard yet: the plan covers the control channels)"}
            </span>
          </div>
          {plan.outOfRange.length > 0 && (
            <div className="banner bad small">
              A {device.name} doesn't tune {plan.outOfRange.map((c) => mhz(c.hz)).join(", ")} MHz.
            </div>
          )}
          <BandPlan windows={plan.windows} outOfRange={plan.outOfRange} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SDR</th>
                  <th>Centre, MHz</th>
                  <th>Sample rate (bandwidth)</th>
                  <th>Records, MHz</th>
                  <th>Channels</th>
                </tr>
              </thead>
              <tbody>
                {plan.windows.map((w, i) => (
                  <tr key={i}>
                    <td>
                      <span className="swatch" style={{ background: sdrColor(i) }} /> {device.name} {i + 1}
                    </td>
                    <td className="mono">
                      {mhz(w.centerHz)}
                      {w.nearDc && <span className="tag" title="A channel is within 25 kHz of the centre, where the device's DC spike is; no centre clears them all">near DC</span>}
                    </td>
                    <td>
                      {msps(w.rateHz)}
                      {device.stretch.includes(w.rateHz) && <span className="tag" title={device.note}>faster rate</span>}
                    </td>
                    <td className="mono small">
                      {mhz(w.lowHz)} – {mhz(w.highHz)}
                    </td>
                    <td className="small">
                      <span className="mono">{w.channels.map((c) => (c.kind === "control" ? `${mhz(c.hz)}*` : mhz(c.hz))).join(", ")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            * a control channel. In Trunk Recorder Pro, add a source for each and set its centre and sample rate as above (Setup → Radios).
            {!rate && " Optimized: planned at the fastest rate its class runs at (no rate takes fewer devices), then each slowed to the lowest that still holds its channels, for less CPU and USB."}
          </p>
        </>
      )}
    </div>
  );
}

/** Each device's span (faint), the part it records well (solid) and its centre, above the channels, coloured by the device that holds them. */
function BandPlan(props: { windows: Window[]; outOfRange: Channel[] }) {
  // Ranges far apart are drawn as their own panels.
  const bands: { windows: [Window, number][]; lo: number; hi: number }[] = [];
  props.windows.forEach((w, i) => {
    const lo = w.centerHz - w.rateHz / 2;
    const hi = w.centerHz + w.rateHz / 2;
    const b = bands[bands.length - 1];
    if (b && lo - b.hi < BAND_GAP_HZ) {
      b.windows.push([w, i]);
      b.hi = Math.max(b.hi, hi);
    } else bands.push({ windows: [[w, i]], lo, hi });
  });
  return (
    <div className="stack">
      {bands.map((b, k) => (
        <Band key={k} {...b} />
      ))}
    </div>
  );
}

const W = 1000;
const LANE = 30;
const AXIS = 54;

function Band(props: { windows: [Window, number][]; lo: number; hi: number }) {
  const pad = (props.hi - props.lo) * 0.03;
  const lo = props.lo - pad;
  const hi = props.hi + pad;
  const x = (hz: number) => ((hz - lo) / (hi - lo)) * W;
  const lanes = props.windows.length;
  const top = 18;
  const axisY = top + lanes * LANE + 10;
  const h = axisY + AXIS;
  const ticks = niceTicks(lo, hi);
  return (
    <figure className="band-plan">
      <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`Band plan, ${mhz(props.lo)} to ${mhz(props.hi)} MHz`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={top - 6} y2={axisY + 30} className="grid" />
            <text x={x(t)} y={h - 4} className="axis" textAnchor="middle">
              {(t / 1e6).toLocaleString(undefined, { maximumFractionDigits: 3 })}
            </text>
          </g>
        ))}
        {props.windows.map(([w, i], lane) => {
          const y = top + lane * LANE;
          const c = sdrColor(i);
          return (
            <g key={i}>
              <title>{`SDR ${i + 1}: centre ${mhz(w.centerHz)} MHz, ${(w.rateHz / 1e6).toFixed(3)} MS/s, records ${mhz(w.lowHz)}–${mhz(w.highHz)} MHz, ${w.channels.length} channels`}</title>
              <rect x={x(w.centerHz - w.rateHz / 2)} y={y} width={x(w.centerHz + w.rateHz / 2) - x(w.centerHz - w.rateHz / 2)} height={LANE - 8} rx={4} fill={c} opacity={0.14} />
              <rect x={x(w.lowHz)} y={y} width={x(w.highHz) - x(w.lowHz)} height={LANE - 8} rx={4} fill={c} opacity={0.38} />
              <line x1={x(w.centerHz)} x2={x(w.centerHz)} y1={y - 2} y2={axisY + 6} stroke={c} strokeDasharray="3 3" strokeWidth={1.5} />
              <text x={x(w.lowHz) + 6} y={y + (LANE - 8) / 2 + 4} className="lane-label">
                {`SDR ${i + 1} · ${mhz(w.centerHz)}`}
              </text>
            </g>
          );
        })}
        <line x1={0} x2={W} y1={axisY + 18} y2={axisY + 18} className="axis-line" />
        {props.windows.flatMap(([w, i]) =>
          w.channels.map((ch) => (
            <g key={`${i}-${ch.hz}`}>
              <title>{`${mhz(ch.hz)} MHz, ${ch.kind === "control" ? "control channel" : "voice channel"}, on SDR ${i + 1}`}</title>
              <line x1={x(ch.hz)} x2={x(ch.hz)} y1={axisY + (ch.kind === "control" ? 0 : 8)} y2={axisY + 18} stroke={sdrColor(i)} strokeWidth={ch.kind === "control" ? 3 : 2} />
              {ch.kind === "control" && <circle cx={x(ch.hz)} cy={axisY} r={4} fill={sdrColor(i)} />}
            </g>
          )),
        )}
      </svg>
      <figcaption className="muted small">
        <span className="legend-dot" /> control channel · <span className="legend-tick" /> voice channel · faint: the device's whole span · solid: what it records well
      </figcaption>
    </figure>
  );
}

/** Round MHz marks, about six across. */
function niceTicks(lo: number, hi: number): number[] {
  const span = hi - lo;
  const step = [0.1e6, 0.25e6, 0.5e6, 1e6, 2e6, 5e6, 10e6, 20e6, 50e6].find((s) => span / s <= 8) ?? 100e6;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return out;
}
