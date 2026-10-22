// The directory's website: what you can hear from where you are, every shared
// system on a map, by state, county and city, and search; a system's page
// (sites, talkgroups, licenses, history), and adding it to Trunk Recorder Pro.

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { BrowsePage } from "./Browse.tsx";
import { ChangesetPage } from "./Changeset.tsx";
import { MapPage } from "./MapPage.tsx";
import { NearPage } from "./Near.tsx";
import { go, Link, useRoute } from "./router.tsx";
import { SearchPage } from "./Search.tsx";
import { SystemPage } from "./System.tsx";
import { setPref, useTheme, type ThemePref } from "./theme.ts";
import "./style.css";


function ThemeSwitch() {
  const { pref } = useTheme();
  return (
    <select className="theme" value={pref} onChange={(e) => setPref(e.target.value as ThemePref)} aria-label="Theme">
      <option value="system">Auto</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}

function SearchBox(props: { q: string }) {
  const [text, setText] = useState(props.q);
  return (
    <form
      className="top-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) go(`/search?q=${encodeURIComponent(text.trim())}`);
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search names, call signs, places…" aria-label="Search the directory" />
    </form>
  );
}

function App() {
  const { path, query } = useRoute();
  let page: React.ReactNode;
  let m: RegExpExecArray | null;
  let wide = false;
  if ((m = /^\/systems\/(sys_[0-9a-z]+)(?:\/(talkgroups|sites|licenses|history))?$/.exec(path))) page = <SystemPage id={m[1]} tab={(m[2] as never) ?? "sites"} query={query} />;
  else if ((m = /^\/changesets\/(cs_[0-9a-z]+)$/.exec(path))) page = <ChangesetPage id={m[1]} />;
  else if (path === "/map") [page, wide] = [<MapPage query={query} />, true];
  else if (path.startsWith("/browse")) page = <BrowsePage path={path} query={query} />;
  else if (path === "/search") page = <SearchPage key={query.get("q") ?? ""} query={query} />;
  else [page, wide] = [<NearPage query={query} />, true];
  const nav = (to: string, label: string, on: boolean) => (
    <Link to={to} className={`nav${on ? " on" : ""}`}>
      {label}
    </Link>
  );
  return (
    <>
      <header className="top">
        <Link to="/" className="brand">
          <span className="logo" aria-hidden="true" />
          <span className="brand-name">Systems directory</span>
        </Link>
        <nav className="navs" aria-label="Views">
          {nav("/", "Near me", path === "/")}
          {nav("/map", "Map", path === "/map")}
          {nav("/browse", "Browse", path.startsWith("/browse"))}
        </nav>
        <SearchBox key={query.get("q") ?? ""} q={path === "/search" ? (query.get("q") ?? "") : ""} />
        <ThemeSwitch />
      </header>
      <main className={wide ? "wide" : ""}>{page}</main>
      {!wide && (
        <footer className="foot muted small">
          Shared by Trunk Recorder Pro users from what their radios decode. Licenses from the FCC, places from the Census Bureau (public domain); map © OpenStreetMap contributors. Nothing here comes from RadioReference.
        </footer>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
