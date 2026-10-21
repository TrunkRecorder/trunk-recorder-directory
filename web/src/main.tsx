// The directory's website: find systems near a place or by anything they have,
// read one (sites, talkgroups, licenses, history), and add it to Trunk Recorder Pro.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChangesetPage } from "./Changeset.tsx";
import { Home } from "./Home.tsx";
import { Link, useRoute } from "./router.tsx";
import { SystemPage } from "./System.tsx";
import "./style.css";

function App() {
  const { path, query } = useRoute();
  let page: React.ReactNode;
  let m: RegExpExecArray | null;
  if ((m = /^\/systems\/(sys_[0-9a-z]+)(?:\/(talkgroups|sites|licenses|history))?$/.exec(path))) page = <SystemPage id={m[1]} tab={(m[2] as never) ?? "sites"} query={query} />;
  else if ((m = /^\/changesets\/(cs_[0-9a-z]+)$/.exec(path))) page = <ChangesetPage id={m[1]} />;
  else page = <Home query={query} />;
  return (
    <>
      <header className="top">
        <Link to="/" className="brand">
          <span className="logo" aria-hidden="true" />
          Systems directory
        </Link>
        <span className="spacer" />
        <a href="/" className="muted">Trunk Recorder Pro</a>
      </header>
      <main>{page}</main>
      <footer className="foot muted small">
        Shared by Trunk Recorder Pro users from what their radios decode. Licenses from the FCC (public domain). Nothing here comes from RadioReference.
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
