// The map for another page to show (the landing page's, in a frame at
// /directory/embed/tour): no header, and it moves itself. It flies from one
// shared system to the next, the biggest first in a shuffled order, ringing
// each one's towers while it stays, then on to the next. A click opens the
// map where the tour is. It pauses while it's out of sight (the page around
// it says, by a message) or pointed at, and jumps instead of flying when the
// viewer asks for less motion.
//
// `?theme=light|dark`: as the page around it is.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { get, nameOf, TYPE, type MapSite } from "./api.ts";
import { TYPE_COLOR } from "./colors.ts";
import { MapView, sitePoints, type View } from "./MapView.tsx";

/** The lower 48, where the tour starts and comes back to. */
const US: View = { center: [39, -97], zoom: 3, fit: [-124.8, 24.5, -66.9, 49.4] };
/** How many systems a round visits. */
const STOPS = 10;
const DWELL_MS = 5500;
const FLY_MS = 6000;

interface Stop {
  system: string;
  name: string;
  type: string;
  sites: number;
  box: [number, number, number, number];
}

/** Each system's towers, as a stop: its box, biggest systems first. */
function stopsOf(sites: MapSite[]): Stop[] {
  const by = new Map<string, Stop>();
  for (const s of sites) {
    if (s.stale || !s.at.length) continue;
    let e = by.get(s.system);
    if (!e) by.set(s.system, (e = { system: s.system, name: nameOf(s), type: s.type, sites: 0, box: [180, 90, -180, -90] }));
    e.sites++;
    for (const [lat, lon] of s.at) e.box = [Math.min(e.box[0], lon), Math.min(e.box[1], lat), Math.max(e.box[2], lon), Math.max(e.box[3], lat)];
  }
  const big = [...by.values()].sort((a, b) => b.sites - a.sites).slice(0, STOPS);
  // (Shuffled, so a visitor who comes back sees somewhere else first.)
  for (let i = big.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [big[i], big[j]] = [big[j], big[i]];
  }
  return big;
}

const wait = (ms: number, alive: () => boolean, paused: () => boolean) =>
  new Promise<void>((done) => {
    let left = ms;
    const step = 250;
    const t = setInterval(() => {
      if (!alive()) return clearInterval(t), done();
      if (!paused()) left -= step;
      if (left <= 0) clearInterval(t), done();
    }, step);
  });

export function TourPage() {
  const [sites, setSites] = useState<MapSite[] | null>(null);
  const [counties, setCounties] = useState<Record<string, number>>({});
  const [map, setMap] = useState<MlMap | null>(null);
  const [stop, setStop] = useState<Stop | null>(null);
  const paused = useRef({ hidden: false, outside: false, hover: false });
  const isPaused = () => paused.current.hidden || paused.current.outside || paused.current.hover;

  useEffect(() => {
    get<{ sites: MapSite[] }>("/map/sites").then((r) => setSites(r.sites), () => setSites([]));
    get<{ counties: Record<string, number> }>("/map/counties").then((r) => setCounties(r.counties), () => {});
    const msg = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const t = (e.data as { trpTour?: string } | null)?.trpTour;
      if (t === "pause" || t === "play") paused.current.outside = t === "pause";
    };
    const vis = () => (paused.current.hidden = document.hidden);
    addEventListener("message", msg);
    document.addEventListener("visibilitychange", vis);
    return () => {
      removeEventListener("message", msg);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  const stops = useMemo(() => (sites ? stopsOf(sites) : []), [sites]);
  const layers = useMemo(() => ({ sites: sitePoints(sites ?? []), counties }), [sites, counties]);

  // The tour: while it's shown, one stop after another, round and round.
  useEffect(() => {
    if (!map || !stops.length) return;
    let alive = true;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pad = () => {
      const w = map.getContainer().clientWidth;
      const h = map.getContainer().clientHeight;
      // (Clear of the caption at the bottom.)
      return { top: h * 0.12, bottom: Math.max(h * 0.12, 90), left: w * 0.1, right: w * 0.1 };
    };
    const go = async (cam: { center: [number, number]; zoom: number }) => {
      if (still) return void map.jumpTo(cam);
      map.flyTo({ ...cam, duration: FLY_MS, curve: 1.5, essential: false });
      await new Promise<void>((done) => map.once("moveend", () => done()));
    };
    const camFor = (box: [number, number, number, number], maxZoom: number) => {
      const c = map.cameraForBounds([[box[0], box[1]], [box[2], box[3]]], { padding: pad(), maxZoom });
      const center = c?.center as { lng: number; lat: number } | undefined;
      return { center: [center?.lng ?? -97, center?.lat ?? 39] as [number, number], zoom: c?.zoom ?? 3 };
    };
    (async () => {
      await wait(1500, () => alive, isPaused);
      for (let round = 0; alive; round++) {
        for (const s of stops) {
          if (!alive) return;
          setStop(null);
          await go(camFor(s.box, 9.5));
          if (!alive) return;
          setStop(s);
          await wait(still ? DWELL_MS * 1.5 : DWELL_MS, () => alive, isPaused);
        }
        // Back out to the whole country between rounds.
        setStop(null);
        await go(camFor(US.fit!, 4));
        await wait(DWELL_MS / 2, () => alive, isPaused);
      }
    })();
    return () => {
      alive = false;
    };
  }, [map, stops]);

  // Where the tour is, on the full map.
  const open = () => {
    if (!map) return;
    const c = map.getCenter();
    const q = new URLSearchParams({ at: `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`, z: (Math.round(map.getZoom() * 10) / 10).toString() });
    if (stop) q.set("sel", stop.system);
    window.open(`/directory/?${q}`, "_top");
  };

  return (
    <div
      className="tour"
      onPointerEnter={() => (paused.current.hover = true)}
      onPointerLeave={() => (paused.current.hover = false)}
      onClick={open}
      title="Open the map here"
    >
      <MapView view={US} layers={layers} selected={stop?.system ?? null} interactive={false} onMap={setMap} className="map-full" label="A tour of the directory's systems" />
      {stop && (
        <a className="tour-card" href={`/directory/systems/${stop.system}`} target="_top" onClick={(e) => e.stopPropagation()} key={stop.system}>
          <span className="dot" style={{ background: TYPE_COLOR[stop.type] ?? "#888" }} />
          <span className="tour-name">{stop.name}</span>
          <span className="tour-meta">
            {TYPE[stop.type] ?? stop.type} · {stop.sites} {stop.sites === 1 ? "site" : "sites"}
          </span>
        </a>
      )}
    </div>
  );
}
