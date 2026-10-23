// What every view shares: which kinds of system it shows (types=, in the URL,
// so a link opens the same view), and putting changes into the URL.

import { TYPE } from "./api.ts";
import { TYPE_COLOR } from "./colors.ts";

export const ALL_TYPES = Object.keys(TYPE);

/** The types a URL asks for: all, when it names none. */
export function typesOf(query: URLSearchParams): string[] {
  const t = (query.get("types") ?? "").split(",").filter((x) => ALL_TYPES.includes(x));
  return t.length ? t : ALL_TYPES;
}

/** `types=` for an API path, or nothing when it's all of them. */
export const typesParam = (types: string[]) => (types.length === ALL_TYPES.length ? "" : `types=${types.join(",")}`);

/** `types` as the URL keeps them: null for all. */
export const typesValue = (types: string[]) => (types.length === ALL_TYPES.length ? null : types.join(","));

/** `path` with `query` changed (null: removed). */
export function withQuery(path: string, query: URLSearchParams, changes: Record<string, string | null>): string {
  const q = new URLSearchParams(query);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === "") q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString().replace(/%2C/g, ",");
  return s ? `${path}?${s}` : path;
}

export function TypeFilter(props: { types: string[]; onChange: (types: string[]) => void }) {
  const all = props.types.length === ALL_TYPES.length;
  const toggle = (t: string) => {
    // From all, a click picks that one; else it's switched; none left is all.
    const next = all ? [t] : props.types.includes(t) ? props.types.filter((x) => x !== t) : [...props.types, t];
    props.onChange(next.length ? ALL_TYPES.filter((x) => next.includes(x)) : ALL_TYPES);
  };
  return (
    <div className="chips" role="group" aria-label="Kinds of system">
      <button className={`chip${all ? " on" : ""}`} aria-pressed={all} onClick={() => props.onChange(ALL_TYPES)}>
        All
      </button>
      {ALL_TYPES.map((t) => (
        <button key={t} className={`chip${!all && props.types.includes(t) ? " on" : ""}`} aria-pressed={!all && props.types.includes(t)} onClick={() => toggle(t)}>
          <span className="dot" style={{ background: TYPE_COLOR[t] }} aria-hidden="true" />
          {TYPE[t]}
        </button>
      ))}
    </div>
  );
}

/** A system's kind, as a small labelled dot. */
export function TypeBadge(props: { type: string }) {
  return (
    <span className="type-badge">
      <span className="dot" style={{ background: TYPE_COLOR[props.type] ?? "#888" }} aria-hidden="true" />
      {TYPE[props.type] ?? props.type}
    </span>
  );
}

/** What a licensed (not shared) system likely is, by its licence's emissions: the scripts' licensedKind. */
export type LicensedKind = "p25" | "dmr" | "nxdn" | "analog" | "";
export const KIND_LABEL: Record<string, string> = { p25: "Likely P25", dmr: "Likely DMR", nxdn: "Likely NXDN", analog: "Analog FM", "": "Type unknown" };

/** Whether the type filter shows a licensed system of this kind (analog under SmartNet or EDACS; unknown only with every type). As src/explore.ts licensedShown. */
export function licensedShown(kind: LicensedKind, types: string[]): boolean {
  if (kind === "analog") return types.includes("smartnet") || types.includes("edacs");
  return kind ? types.includes(kind) : types.length === ALL_TYPES.length;
}
