// Light, dark, or as the system is: the viewer's choice, kept in this browser
// (the page works the same without storage). The map draws its own colours
// for each (mapStyle.ts).

import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "trp.directory.theme";

export function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(p: ThemePref) {
  if (p === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = p;
}

export function setPref(p: ThemePref) {
  try {
    if (p === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {}
  apply(p);
  dispatchEvent(new Event("trp:theme"));
}

const dark = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;

/** The theme chosen, and the one in effect. */
export function useTheme(): { pref: ThemePref; effective: "light" | "dark" } {
  const read = () => {
    const pref = readPref();
    return { pref, effective: pref === "system" ? (dark() ? "dark" : "light") : pref } as const;
  };
  const [t, setT] = useState(read);
  useEffect(() => {
    apply(readPref());
    const on = () => setT(read());
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", on);
    addEventListener("trp:theme", on);
    return () => {
      mq.removeEventListener("change", on);
      removeEventListener("trp:theme", on);
    };
  }, []);
  return t;
}
