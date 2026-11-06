// The directory's website: what you can hear from where you are, every shared
// system on a map, by state, county and city, and search; a system's page
// (sites, talkgroups, licenses, history), and adding it to Trunk Recorder Pro.

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { BrowsePage } from "./Browse.tsx";
import { ChangesetPage } from "./Changeset.tsx";
import { ExplorePage } from "./Explore.tsx";
import { go, Link, useRoute } from "./router.tsx";
import { SearchPage } from "./Search.tsx";
import { SystemPage } from "./System.tsx";
import { forceTheme, setPref, useTheme, type ThemePref } from "./theme.ts";
import { TourPage } from "./Tour.tsx";
import "./style.css";

/** The site's mark, as the landing page has it (trunkrecorder.pro). */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#0d1117" />
      <path d="M6 22 L11 12 L16 19 L21 8 L26 22" stroke="#3fb6ff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Redirect(props: { to: string }) {
  useEffect(() => go(props.to, true), []);
  return null;
}

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
  // A page for another page to show (the landing page's map): no header or footer.
  if (path === "/embed/tour") return <TourPage />;
  let page: React.ReactNode;
  let m: RegExpExecArray | null;
  let wide = false;
  if ((m = /^\/systems\/((?:sys|fcc)_[0-9a-z]+)(?:\/(talkgroups|sites|licenses|history|sdrs))?$/.exec(path))) page = <SystemPage id={m[1]} tab={(m[2] as never) ?? "sites"} query={query} />;
  else if ((m = /^\/changesets\/(cs_[0-9a-z]+)$/.exec(path))) page = <ChangesetPage id={m[1]} />;
  // (The map was /map: it's the home page now, its links still work.)
  else if (path === "/map") page = <Redirect to={`/${location.search}`} />;
  else if (path.startsWith("/browse")) page = <BrowsePage path={path} query={query} />;
  else if (path === "/search") page = <SearchPage key={query.get("q") ?? ""} query={query} />;
  else [page, wide] = [<ExplorePage query={query} />, true];
  const nav = (to: string, label: string, on: boolean) => (
    <Link to={to} className={`nav${on ? " on" : ""}`}>
      {label}
    </Link>
  );
  return (
    <>
      <header className="top">
        <div className="top-inner">
          <a href="/" className="brand" aria-label="Trunk Recorder Pro home">
            <Mark />
            <span className="brand-name">Trunk Recorder Pro</span>
          </a>
          <span className="brand-sep" aria-hidden="true">/</span>
          <Link to="/" className="brand-sub">
            Directory
          </Link>
          <nav className="navs" aria-label="Views">
            {nav("/", "Map", path === "/" || path === "/map")}
            {nav("/browse", "Browse", path.startsWith("/browse"))}
          </nav>
          <SearchBox key={query.get("q") ?? ""} q={path === "/search" ? (query.get("q") ?? "") : ""} />
          <ThemeSwitch />
          <a className="btn primary top-cta" href="/#install">
            Get Trunk Recorder Pro
          </a>
        </div>
      </header>
      <main className={wide ? "wide" : ""}>{page}</main>
      {!wide && (
        <footer className="foot">
          <div className="foot-inner">
            <div className="foot-brand">
              <a href="/" className="brand">
                <Mark />
                <span>Trunk Recorder Pro</span>
              </a>
              <p className="muted small">
                Shared by Trunk Recorder Pro users from what their radios decode. Licenses from the FCC, places from the Census Bureau (public domain); map © OpenStreetMap contributors. Nothing here comes from RadioReference.
              </p>
            </div>
            <div className="foot-links">
              <div>
                <h5>Directory</h5>
                <Link to="/">Map</Link>
                <Link to="/browse">Browse by place</Link>
                <a href="https://github.com/TrunkRecorder/trunk-recorder-directory#the-api">API</a>
              </div>
              <div>
                <h5>Trunk Recorder Pro</h5>
                <a href="/">Home</a>
                <a href="/#install">Install</a>
                <a href="/app/">Web app</a>
                <a href="https://github.com/TrunkRecorder/trunk-recorder-pro">Source code</a>
              </div>
            </div>
          </div>
        </footer>
      )}
    </>
  );
}

// The embedded map is shown as the page around it is (?theme=), whatever this browser chose for the directory.
if (location.pathname.startsWith("/directory/embed/")) {
  const t = new URLSearchParams(location.search).get("theme");
  if (t === "light" || t === "dark") forceTheme(t);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
