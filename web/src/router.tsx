// Moving around the app without reloading: paths under /directory.

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

/** Go to a path under /directory (`replace`: without a new history entry). */
export function go(path: string, replace = false): void {
  const url = `${BASE}${path}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
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

