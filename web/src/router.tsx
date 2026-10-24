// Moving around the app without reloading: paths under /directory. Each
// history entry keeps the trail it was reached by (the page it came from, and
// that page's trail), so a page can say how to get back the way you came
// (Page.tsx), through the browser's back button and a reload too.

import { useEffect, useState } from "react";

const BASE = "/directory";

/** Where the app is: its path under /directory and its query. */
export function useRoute(): { path: string; query: URLSearchParams } {
  const read = () => ({ path: location.pathname.slice(BASE.length) || "/", query: new URLSearchParams(location.search) });
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => setR(read());
    addEventListener("popstate", on);
    addEventListener("trp:navigate", on);
    return () => {
      removeEventListener("popstate", on);
      removeEventListener("trp:navigate", on);
    };
  }, []);
  return r;
}

/** A step of the way here: what it's called, and where it is (a path under /directory, with its query). */
export interface Crumb {
  label: string;
  to: string;
}

/** The page shown now: its trail and what it's called (Page.tsx and the map say). */
let here: { trail: Crumb[]; label: string } = { trail: [], label: "" };
export function setHere(trail: Crumb[], label: string): void {
  here = { trail, label };
}

const current = () => location.pathname.slice(BASE.length) + location.search;

/** The trail this entry was reached by: the page it came from, last. Null: opened directly. */
export function cameFrom(): Crumb[] | null {
  const s = history.state as { from?: Crumb[] } | null;
  return s?.from?.length ? s.from : null;
}

/** Go to a path under /directory (`replace`: without a new history entry, keeping how it was reached). */
export function go(path: string, replace = false): void {
  const url = `${BASE}${path}`;
  if (replace) history.replaceState(history.state, "", url);
  else history.pushState({ from: here.label ? [...here.trail, { label: here.label, to: current() }] : [] }, "", url);
  dispatchEvent(new Event("trp:navigate"));
  if (!replace) scrollTo(0, 0);
}

/** A link inside the app. */
export function Link(props: { to: string; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <a
      href={`${BASE}${props.to}`}
      className={props.className}
      title={props.title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(props.to);
      }}
    >
      {props.children}
    </a>
  );
}

