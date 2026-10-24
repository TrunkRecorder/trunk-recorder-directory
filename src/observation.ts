// A share from Trunk Recorder Pro: one trunked system as its config has it
// (TRP's own terms: config.json's System, its talkgroup file's rows, its `fcc`
// map), and what the recorder heard of it (its decode). Version 1.
//
// What is never in one: keys, plugin settings, unit names or aliases, paths,
// or where the recorder is. (Where a system is comes from its licensed towers.)

export const OBSERVATION_VERSION = 1;
export const MAX_SITES = 64;
export const MAX_TALKGROUPS = 20_000;
export const MAX_FREQS = 256;

export interface SiteIdentity {
  nac?: number | null;
  wacn?: number | null;
  sysId?: number | null;
  rfss?: number | null;
  site?: number | null;
}

/** A site as TRP's config has it. */
export interface ObservedSite {
  /** The directory's ID for it, if TRP has one (it was imported, or shared before). */
  directoryId?: string;
  name?: string;
  controlChannelsHz: number[];
  /** The site lock (`expect`). */
  expect?: SiteIdentity;
  voiceChannelsHz?: number[];
  modulation?: string;
  bandplan?: Record<string, unknown> | null;
  /** What the recorder heard there (its decode, this run). */
  heard?: {
    identity?: SiteIdentity;
    /** The control channel it's on now. */
    controlChannelHz?: number | null;
    /** Voice channels granted, with how many grants. */
    voice?: { freqHz: number; grants: number }[];
    /** Neighbouring sites the control channel announces. */
    neighbours?: { sysId?: number | null; rfss: number; site: number; freqHz: number }[];
    /** Call signs heard on the air (Motorola's base station ID). */
    callSigns?: { freqHz: number; callSign: string }[];
    /** Control messages decoded and lost. */
    good?: number;
    bad?: number;
  };
}

/** A row of TRP's talkgroup file. */
export interface ObservedTalkgroup {
  number: number;
  alpha?: string;
  description?: string;
  mode?: string;
  tag?: string;
  category?: string;
  priority?: string;
  /** Where the row came from in TRP: the user, the air, the directory, a RadioReference paste. RR rows are never sent. */
  source?: "user" | "air" | "directory";
}

export interface Observation {
  v: 1;
  /** The install's random, anonymous ID (`r_` + 10 to 26 base32). */
  recorder: string;
  app: string;
  /** The directory system it was imported from or shared to before, and the version it had then. */
  directory?: { id: string; rev: number } | null;
  system: {
    type: "p25" | "smartnet" | "dmr" | "nxdn";
    name?: string;
    fcc?: Record<string, { callSign: string; name?: string; from?: "user" | "air" | "lookup" }>;
    sites: ObservedSite[];
  };
  talkgroups?: ObservedTalkgroup[];
  /** Talkgroups granted, with how often, where (site indexes into system.sites) and whether encrypted. */
  heardTalkgroups?: { number: number; grants: number; sites?: number[]; encrypted?: boolean }[];
}

export class Invalid extends Error {}

const isInt = (v: unknown, lo = 0, hi = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isFreq = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 1e6 && v <= 6e9;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

/** A share as sent, checked and trimmed: fields of the wrong type are dropped; a broken shape is refused. */
export function parseObservation(x: unknown): Observation {
  const o = x as Partial<Observation>;
  if (!o || typeof o !== "object") throw new Invalid("not a JSON object");
  if (o.v !== OBSERVATION_VERSION) throw new Invalid(`v must be ${OBSERVATION_VERSION}`);
  if (typeof o.recorder !== "string" || !/^r_[0-9a-hjkmnp-tv-z]{10,26}$/.test(o.recorder)) throw new Invalid("recorder must be r_ and 10 to 26 base32 characters");
  const sys = o.system;
  if (!sys || typeof sys !== "object") throw new Invalid("system is required");
  if (!["p25", "smartnet", "dmr", "nxdn"].includes(sys.type as string)) throw new Invalid("system.type must be p25, smartnet, dmr or nxdn");
  if (!Array.isArray(sys.sites) || !sys.sites.length || sys.sites.length > MAX_SITES) throw new Invalid(`system.sites must have 1 to ${MAX_SITES} sites`);
  const ident = (i: unknown): SiteIdentity | undefined => {
    if (!i || typeof i !== "object") return undefined;
    const r = i as Record<string, unknown>;
    const out: SiteIdentity = {};
    if (isInt(r.nac, 0, 0xfff)) out.nac = r.nac;
    if (isInt(r.wacn, 0, 0xfffff)) out.wacn = r.wacn;
    if (isInt(r.sysId, 0, 0xffff)) out.sysId = r.sysId;
    if (isInt(r.rfss, 0, 255)) out.rfss = r.rfss;
    if (isInt(r.site, 0, 255)) out.site = r.site;
    return out;
  };
  const freqs = (v: unknown) => (Array.isArray(v) ? v.filter(isFreq).slice(0, MAX_FREQS) : []);
  const sites: ObservedSite[] = sys.sites.map((s, i) => {
    if (!s || typeof s !== "object") throw new Invalid(`system.sites[${i}] isn't an object`);
    const ccs = freqs(s.controlChannelsHz);
    if (!ccs.length) throw new Invalid(`system.sites[${i}] has no control channel`);
    const h = s.heard && typeof s.heard === "object" ? s.heard : undefined;
    return {
      directoryId: typeof s.directoryId === "string" && /^site_[0-9a-z]{6,26}$/.test(s.directoryId) ? s.directoryId : undefined,
      name: str(s.name, 64),
      controlChannelsHz: ccs,
      expect: ident(s.expect),
      voiceChannelsHz: freqs(s.voiceChannelsHz),
      modulation: str(s.modulation, 16),
      bandplan: s.bandplan && typeof s.bandplan === "object" ? s.bandplan : null,
      heard: h && {
        identity: ident(h.identity),
        controlChannelHz: isFreq(h.controlChannelHz) ? h.controlChannelHz : null,
        voice: (Array.isArray(h.voice) ? h.voice : []).filter((v) => isFreq(v?.freqHz) && isInt(v?.grants)).slice(0, MAX_FREQS),
        neighbours: (Array.isArray(h.neighbours) ? h.neighbours : [])
          .filter((n) => isInt(n?.rfss, 0, 255) && isInt(n?.site, 0, 255) && isFreq(n?.freqHz))
          .map((n) => ({ sysId: isInt(n.sysId, 0, 0xffff) ? n.sysId : null, rfss: n.rfss, site: n.site, freqHz: n.freqHz }))
          .slice(0, 64),
        callSigns: (Array.isArray(h.callSigns) ? h.callSigns : [])
          .filter((c) => isFreq(c?.freqHz) && typeof c?.callSign === "string" && /^[A-Z0-9]{3,8}$/.test(c.callSign))
          .slice(0, MAX_FREQS),
        good: isInt(h.good) ? h.good : undefined,
        bad: isInt(h.bad) ? h.bad : undefined,
      },
    };
  });
  const tgs = (Array.isArray(o.talkgroups) ? o.talkgroups : []).slice(0, MAX_TALKGROUPS).flatMap((t): ObservedTalkgroup[] => {
    if (!t || !isInt(t.number, 1, 0xffffff)) return [];
    return [{
      number: t.number,
      alpha: str(t.alpha, 64),
      description: str(t.description, 200),
      mode: str(t.mode, 8),
      tag: str(t.tag, 40),
      category: str(t.category, 64),
      priority: str(t.priority, 8),
      source: t.source === "air" || t.source === "directory" ? t.source : "user",
    }];
  });
  const heardTgs = (Array.isArray(o.heardTalkgroups) ? o.heardTalkgroups : []).slice(0, MAX_TALKGROUPS).flatMap((t) =>
    t && isInt(t.number, 1, 0xffffff) && isInt(t.grants)
      ? [{ number: t.number, grants: t.grants, sites: Array.isArray(t.sites) ? t.sites.filter((k) => isInt(k, 0, sites.length - 1)) : [], encrypted: t.encrypted === true }]
      : [],
  );
  const fcc: NonNullable<Observation["system"]["fcc"]> = {};
  for (const [k, v] of Object.entries(sys.fcc && typeof sys.fcc === "object" ? sys.fcc : {})) {
    const hz = Number(k);
    if (isFreq(hz) && v && typeof v.callSign === "string" && /^[A-Z0-9]{3,8}$/.test(v.callSign)) {
      fcc[String(Math.round(hz / 6250) * 6250)] = { callSign: v.callSign, name: str(v.name, 120), from: v.from === "air" || v.from === "lookup" ? v.from : "user" };
    }
  }
  const dir = o.directory && typeof o.directory === "object" && typeof o.directory.id === "string" && isInt(o.directory.rev) ? { id: o.directory.id, rev: o.directory.rev } : null;
  return {
    v: 1,
    recorder: o.recorder,
    app: str(o.app, 32) ?? "",
    directory: dir,
    system: { type: sys.type, name: str(sys.name, 80), fcc, sites },
    talkgroups: tgs,
    heardTalkgroups: heardTgs,
  };
}
