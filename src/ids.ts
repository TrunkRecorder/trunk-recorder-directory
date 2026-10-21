// The directory's IDs: a kind prefix and 10 random base32 characters
// (Crockford's alphabet, lower case). Opaque and permanent: a merged record's
// ID becomes a redirect, never reused.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type IdKind = "sys" | "site" | "tg" | "fq" | "nb" | "lic" | "cl" | "cand" | "sup" | "lock" | "cs" | "obs" | "mp";

export function newId(kind: IdKind): string {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += ALPHABET[x & 31];
  return `${kind}_${s}`;
}

/** An ID as this directory makes them (`sys_…`), or a recorder's (`r_…`). */
export const isId = (s: string, kind: string) => new RegExp(`^${kind}_[0-9a-hjkmnp-tv-z]{6,26}$`).test(s);
