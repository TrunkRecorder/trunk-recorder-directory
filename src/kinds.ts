// What kinds of system there are, and what a licensed (not shared) system
// likely is: rules the server and the website both follow, here once. (Pure:
// the website imports it without the server's database code.)

export const TYPES = ["p25", "smartnet", "dmr", "nxdn", "edacs"] as const;

/** What a licensed system likely is: its digital mode, or analog FM (SmartNet, EDACS, LTR: emissions can't tell), or unknown. */
export type LicensedKind = "p25" | "dmr" | "nxdn" | "analog" | "";

/** Emission designators by what carries them (the bandwidth, then the modulation and what's sent). */
const KIND_OF: [Exclude<LicensedKind, "">, RegExp][] = [
  ["p25", /^(8K10F1[EDW]|8K70D1[EDW]|9K80D7[EDW]|9K70D7W)$/], // C4FM, LSM/CQPSK simulcast, Phase 2 H-DQPSK
  ["dmr", /^7K60FX[EDW]$/],
  ["nxdn", /^(4K00F1[EDW]|4K00F7W|8K30F1[EDW]|8K30F7W)$/], // 6.25 kHz (dPMR shares it), 12.5 kHz
  ["analog", /F3E$/], // FM voice
];

/**
 * What a licensed system likely is, from its emissions (each frequency's
 * licensed emissions, comma separated): the digital mode on the most of its
 * frequencies; else analog FM; else unknown. A license often keeps analog
 * beside digital, so digital wins.
 */
export function licensedKind(emissionsPerFrequency: (string | null)[]): LicensedKind {
  const n: Record<string, number> = {};
  for (const e of emissionsPerFrequency) {
    const kinds = new Set<string>();
    for (const code of (e ?? "").split(",")) for (const [k, re] of KIND_OF) if (re.test(code.trim().toUpperCase())) kinds.add(k);
    for (const k of kinds) n[k] = (n[k] ?? 0) + 1;
  }
  const digital = (["p25", "dmr", "nxdn"] as const).filter((k) => n[k]).sort((a, b) => n[b] - n[a]);
  return digital[0] ?? (n.analog ? "analog" : "");
}

/** Whether the type filter shows a licensed system of this kind (analog under SmartNet or EDACS; unknown only with every type). */
export function licensedShown(kind: LicensedKind, types: string[]): boolean {
  if (kind === "analog") return types.includes("smartnet") || types.includes("edacs");
  return kind ? types.includes(kind) : types.length === TYPES.length;
}

