// Every page but the map is laid out the same way: the way back (a trail of
// where you came from, each a link back to it as you left it), then its title
// with its actions on the right, a line about it, and its body. Dialogs are
// one way too: the title and × at the top, the buttons at the bottom right,
// the main one last; Escape or a click outside closes.

import { useEffect, useRef, type ReactNode } from "react";
import { cameFrom, Link, setHere, type Crumb } from "./router.tsx";

/**
 * A page. `trail`: where it is under (Browse's places), or by default the way
 * you came (`fallback` when opened directly). `self`: the path that is this
 * page whatever its tab or query, so moving between its tabs doesn't add it
 * to its own trail.
 */
export function Page(props: { title: ReactNode; label: string; self: string; trail?: Crumb[]; fallback?: Crumb[]; actions?: ReactNode; meta?: ReactNode; children: ReactNode }) {
  const came = cameFrom();
  let trail = props.trail ?? came ?? props.fallback ?? [{ label: "Map", to: "/" }];
  const own = trail.findIndex((c) => c.to === props.self || c.to.startsWith(`${props.self}/`) || c.to.startsWith(`${props.self}?`));
  if (own >= 0) trail = trail.slice(0, own);
  if (!trail.length) trail = props.fallback ?? [{ label: "Map", to: "/" }];
  setHere(trail, props.label);
  return (
    <div className="stack page">
      <nav className="crumbs small" aria-label="The way back">
        {trail.map((c, i) => (
          <span key={`${i}-${c.to}`}>
            {i === 0 && <span aria-hidden="true">← </span>}
            {i > 0 && <span className="muted"> › </span>}
            <Link to={c.to}>{c.label}</Link>
          </span>
        ))}
      </nav>
      <header className="page-head">
        <h1>{props.title}</h1>
        {props.actions && <div className="row page-actions">{props.actions}</div>}
      </header>
      {props.meta && <div className="kv muted page-meta">{props.meta}</div>}
      {props.children}
    </div>
  );
}

/** A close button (×), where a dialog or a card that can be dismissed has it: top right. */
export function CloseButton(props: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="close-x" aria-label={props.label} title={props.label} onClick={props.onClick}>
      ×
    </button>
  );
}

/** A dialog: its title and × at the top, its body, its buttons at the bottom right (`actions`: the main one last). */
export function Dialog(props: { title: string; onClose: () => void; actions: ReactNode; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  return (
    <div className="modal-back" onClick={props.onClose}>
      <div className="modal stack" role="dialog" aria-modal="true" aria-label={props.title} ref={box} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>{props.title}</h3>
          <CloseButton onClick={props.onClose} label="Close" />
        </header>
        <div className="stack">{props.children}</div>
        <footer className="modal-actions">{props.actions}</footer>
      </div>
    </div>
  );
}
