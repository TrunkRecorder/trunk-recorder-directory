# A shared directory of systems: design plan

October 2026. The design this repo builds; parts not built yet are marked in "Phases". It covers how trunkrecorder.pro
could hold radio systems that Trunk Recorder Pro users share, and hand them
back to other users near them:

- how systems and sites are identified, and kept together;
- talkgroups;
- conventional channels;
- geography: what can I hear from here;
- how it differs from RadioReference.

It builds on what exists:

- the `fcc` map of licenses by frequency (PR #62);
- Motorola base station IDs heard on the air;
- the `trp-api` Worker on trunkrecorder.pro with ArgusRF's FCC ULS data in D1 (argusrf#1);
- the survey.

## What RadioReference does, and where we can do better

RadioReference (RR) is the reference everyone uses. Its database is organised
by place:

- country → state → county (plus metro areas and "statewide");
- in each, **agencies** with conventional frequencies in categories and subcategories;
- **trunked systems** with sites, frequencies and talkgroups in talkgroup categories.

Records carry a function tag ("Fire Dispatch", "Law Tac"). Sites carry RFSS, NAC
and a location. Counties, agencies, subcategories, systems, sites and talkgroup
categories carry rectangle location data, and Uniden's scanners select systems by
that location and range. In practice, users report many records sitting at default
values, so a scanner picks far more than is local.

Data comes in through a submission form. A volunteer state or system administrator
reviews it, and it must be "personally verified". Data copied from the FCC database is
refused unless the contributor confirms the frequency is in use. A SOAP web service
exposes the database to premium subscribers, with each end user logging in with their
own RR account. The terms prohibit use beyond private, personal viewing without a
license.
([Web Service 3.1](https://wiki.radioreference.com/index.php/RadioReference.com_Web_Service3.1),
[API terms](https://support.radioreference.com/hc/en-us/articles/18844460198932-Database-Web-Service-API),
[Submission guidelines](https://wiki.radioreference.com/index.php/RR_Database_Submission_Guidelines),
[Restricted info](https://wiki.radioreference.com/index.php/Restricted_Info),
[HomePatrol location/range thread](https://forums.radioreference.com/threads/location-and-range-updates-for-homepatrol.201948))

| | RadioReference | What we can do |
|---|---|---|
| Where data comes from | People typing what they heard; an admin re-typing it | The recorder's own decode: identities, control channels, voice channels and talkgroups that were actually granted, call signs heard on the air. People add names and descriptions. |
| How fresh it is | Whenever someone submits. "Last updated" is per record and often years old. | Every sharing recorder refreshes "last heard". Retired control channels and dead talkgroups age out visibly. |
| Identity | A database ID per system (`sid`); matching the air to a record is left to the user | Records are keyed by what the air says (WACN/SysID/RFSS/Site, NAC, colour code, RAN, call sign), so a recorder can say "this is that system" by itself. |
| Location | County membership plus hand-set rectangles, often defaults | Transmitter coordinates from FCC ULS (by call sign and frequency). A recorder's location is never stored. |
| Getting it into a radio | A paid API, per-user RR login, SOAP | An open JSON API on trunkrecorder.pro; one click in TRP adds a system with its sites, talkgroups and licenses |
| License | Private viewing only; anything else needs a license | Open data (see Licensing). FCC data is public domain. RR data is never imported. |
| Moderation | A volunteer admin per state, reviewing everything | Facts heard on the air are applied automatically when independent recorders agree. People review only what a person wrote (names, descriptions, merges). |

We should keep what RR got right:

- organising conventional channels by who uses them (agencies);
- function tags;
- people's local knowledge of what a talkgroup is for.

## Principles

1. **The air is the source of truth for structure; people are for meaning.**
   - Control channels, identities, voice channels, which talkgroups are in use,
     and call signs come from decodes.
   - Names, descriptions and tags come from people.
2. **Every record knows where it came from** (air, FCC, a person, an import) and when.
   That's the `from` idea already in the `fcc` map.
3. **IDs are ours and never change. Natural keys are evidence.**
   - The air's identifiers aren't unique enough to be primary keys (see below).
   - Instead they are claims that point at a record.
4. **Systems are where their licensed towers are; recorders are nowhere.**
   - A share carries no location, and the server keeps none of a recorder's.
   - A person may send a point to ask what's around it. That point answers the
     question and is dropped.
   - A recorder can fetch the towers and work out locally where it is relative to them.
5. **The directory speaks TRP's config.**
   - What it hands out is `System`/`Site`/talkgroup CSV/`fcc` as `config.json` has them.
   - What it takes in is the same, plus evidence.

## Entities

```
Network (optional)        a WACN, or a statewide network spanning several systems
  └── System              what a recorder records as one system (TRP System)
        ├── Site          a control channel's site (TRP Site)
        │     └── Frequency uses: control (primary/alternate), voice, repeater; each with its FCC license
        ├── Talkgroup     scoped to the system (or to its network)
        └── TalkgroupCategory / tags
Agency                    who uses something: a licensee (FCC name) or a department
  └── Channel             a conventional frequency use: frequency + access code, with talkgroups for digital ones
Observation               one recorder's report of a system/site/channel (what TRP shares)
Revision                  every change to a record: who/what, from which observations
```

### Identifiers

Every record gets an **opaque, permanent ID** from the server: a type prefix plus a
short base32 random string, such as `sys_7k2m9qx4`, `site_…`, `tg_…`, `ch_…`,
`ag_…`. Changes go:

- **Merging two records:** one ID becomes a redirect to the other. It isn't reused
  or deleted, so a recorder holding the old ID still resolves.
- **Splitting a record:** it gets a new ID; the old one stays with the larger part.
- **Readable URLs:** a slug such as `/systems/dc-fems` is a label, not an identity.

**Identity claims** link what the air says to records. Each is a row of
`(kind, key) → record`, with a count of independent observations and a
first-seen/last-seen date. A new observation is matched through its claims.
Here's what each protocol offers, and why none of it is a safe primary key:

| Protocol | System claim | Site claim | Caveats |
|---|---|---|---|
| P25 Phase 1/2 trunked | `p25:{WACN}.{SysID}` | `…/{RFSS}.{Site}` | WACN BEE00 is a common default, and SysIDs repeat across WACNs. A WACN with several SysIDs is a Network. Simulcast sites share one site ID across several transmitters. |
| P25 conventional | — | — | NAC plus frequency, near a place (a channel claim, not a system) |
| SmartNet / SmartZone | `smartnet:{SysID}` **+ region** | `…/{site number}` | 16-bit SysIDs repeat across the country, so they only identify together with a coarse region: the H3 resolution-3 cell of the system's licensed towers |
| DMR Capacity Max / Tier III | `dmr-t3:{system identity code}` + region | `…/{site}` | The same, and many installs are small |
| DMR Capacity Plus / Connect Plus | `dmr-cp:{rest channel set}` + region | — | No system ID on the air. Identified by frequency set and colour code near a place. |
| NXDN Type-C | `nxdn:{system code}` + region | `…/{site code}` | RAN is per channel, not an identity |
| Any | `fcc:{type}:{call sign}` | — | Taken from the towers a share is placed at, and from call signs heard on the air. Nationwide and strong: the systems a share's call signs name are the same system, unless the air says otherwise (a different WACN or SysID). One license can hold two systems, and they stay apart. |
| Conventional | — | — | `{frequency}/{access code}@{cell}` |

Matching scores the claims and decides:
- **Strong match** (a WACN.SysID that isn't the default and is in the same region, or two
  independent strong claims): the observation attaches to the record.
- **Conflict** (the same claim near two different records): it goes to a person.
- **No match:** a new record, provisional until a second recorder (or the FCC) confirms it.

**A system found twice** (`src/twins.ts`). Recorders at two ends of a statewide system share it
before either names the other. So after a system's sites are placed at their licensed towers,
the records that are it are merged into one. Each of these counts only when nothing on the air
disagrees, because a WACN or a SysID that differs is another system, even under one license:
- the same licensed tower, under the same call sign;
- its weak identity, claimed in the regions its towers are in, and held by another record
  there or in a neighbouring region;
- the same FCC licensee, compared by name however it's written ("MADISON, COUNTY OF" is
  "Madison County"):
  - with the same identity, at any distance (State of Indiana - IPSC's two ends are regions
    apart, under different call signs);
  - with no identity on one of them (DMR, or a site not decoded yet), only when their towers
    are within 50 km.

This runs after every share and on an admin re-place (`POST /place`), which mends records made
before a rule existed.

### Systems and sites

A site belongs to exactly one system (`site.system_id`). Its own identity is its
site claim, which is under the system's: `p25:BEE00.3A9/1.5`. A site moving to
another system is a re-parent, done as a revision, and keeps its ID. That matches what
happens on the air: a site re-homed to a new core, or two records found to be one system.

**When two site records are one site** (`src/sites.ts`, the one rule for all three cases below): site numbers
decide when both sites have them (P25 RFSS and site; SmartNet, DMR and NXDN site), so 1-3 and 1-4 stay two
sites even with a control channel in common. When either has no number, a control channel in common makes
them one. The rule is used in three places:
- A share matched to a system looks for any site it didn't name among that system's own sites. A recorder's
  first share after an import names no site IDs, and a weak identity with no region has no claims to match on.
- A system merge joins the sites that are one site.
- After placing, a system's own sites recorded twice are merged. The one first heard is kept, and the other's
  ID redirects to it.

What a site holds:
- its control channels, primary and alternates, each with first and last heard;
- the voice channels granted from it, with how often;
- the neighbours it announces (the adjacent list, as site-to-site links);
- the band plan;
- modulation (C4FM, or CQPSK simulcast);
- the NAC;
- its FCC licenses by frequency, which is the `fcc` map, now per site;
- its location (below).

A **Network** is optional:
- **When it's added:** when several systems share a WACN, or announce each other.
  Examples are statewide systems with one SysID per region, and ISSI-linked systems.
- **Why it matters:** talkgroups shared network-wide (statewide interop) live on the
  network, not on each system.

### Talkgroups

A talkgroup is `(scope, number)`. The scope is a system or a network, and the
number is decimal: P25 16-bit, DMR 24-bit, NXDN 16-bit.
- **Its fields** match TRP's talkgroup CSV: alpha tag, description, mode
  (D/A/T/E…), tag (service type), category (group), priority. That makes export
  to TRP and Trunk Recorder lossless.
- **From the air:** first and last granted, how often, from which sites, and whether
  it was seen encrypted (and with which algorithm). This is what a recorder knows and
  RR doesn't.
- **An unnamed talkgroup** heard by several recorders is listed as *heard, not
  named yet*. Reviewers can work from that list, which beats RR's wiki pages of
  unknown talkgroups.
- **Patches:** supergroups, and the talkgroups patched into them, are recorded as
  links between talkgroups, so a supergroup isn't mistaken for a talkgroup.

Service tags should be a small fixed list (Law Dispatch, Fire Dispatch, EMS,
Fire-Tac, Public Works, Schools, Transportation, Interop…), so TRP can filter on them.
Categories stay free text per system.

### Conventional

Conventional doesn't fit "system" well. A county's FM fire dispatch, a city's DMR
repeater with talkgroups, and a business's P25 conventional channel are all
"frequencies used by someone, somewhere". So the directory stores **channels**, owned
by **agencies**. TRP's conventional system is a list the user makes from them.

- **Channel:**
  - **Identity:** frequency (on the raster) + access code + place. The access code
    is TRP's `tone`: CTCSS/DCS, NAC, DMR CC/TS/TG, or NXDN RAN.
  - **Fields:** mode, bandwidth, input frequency (repeaters), FCC license (call sign,
    from `fcc`), alpha tag, description, service tag.
  - **Talkgroups:** a digital conventional channel lists them (DMR TS/TG pairs, P25
    talkgroups), with the same fields as a trunked talkgroup.
  - **From the air:** codes heard (TRP already tracks `heard` codes per frequency),
    last heard.
- **Agency:** usually an FCC licensee (an `fcc` name), which gives it a home location
  from the license. A person can rename it ("Arlington County Fire"), split it, or
  merge it.
- **Shared channels:** some channels are used by many agencies (mutual aid, NIFOG
  interop, shared business). They're one channel with several agencies linked, and a
  scope of `national`/`state`/`regional` instead of a single location.
- **Networked conventional:** DMR Capacity Plus without trunking, IP-linked
  repeaters. These are channels linked into a "group" that behaves like a site
  set. It's the same pattern as Network, kept optional.
- **Sharing:** TRP's conventional system is broken into channels. The system's
  `name` becomes a *collection* label ("County Fire"), and the user can publish the
  collection as a ready-made list that points at the channels.
- **Importing:** a user picks channels (or a collection) near them, and TRP builds a
  conventional system from them.

## Geography

**Where transmitters are:**
1. **FCC ULS.** The `fcc` map gives a call sign and a frequency. ULS has that
   license's locations (fixed sites with coordinates, height and ERP; or a mobile area
   with a radius). ArgusRF's D1 already holds this data. Most public-safety and business
   sites get a location with no one entering it.
2. **People:** placing a site on a map in the web editor.
3. **Inference:** a site heard only by recorders in one area sits near them. That's a
   weak guess, labelled as one.

**As built (src/place.ts):** a site's transmitters are the licensed base and repeater
stations (station class FB…, which ArgusRF keeps since 2026-10-18) on its frequencies,
kept in `site_transmitters` with their height, ERP and state, county and Census place.
Each licensed spot is scored by how many of the site's frequencies are licensed there,
across call signs (one tower can hold its channels under several). The call signs the
system has (heard on the air, typed, looked up) win ties; with none, the frequencies
alone (a "fingerprint") place it when a spot holds two or more of them. Two equally
good spots far apart (a channel reused across a state) aren't guessed: `placements`
says why. A simulcast site keeps every tower. Placing runs after each share, again when
a site's frequencies change, and monthly.

**Where it can be received:** each site carries a coverage estimate, from two sources.
- **Predicted coverage:**
  - the FCC location's ERP and antenna height;
  - the radio horizon and a simple path-loss model (Hata-like, with no terrain at first);
  - stored as a radius.
- **No observed coverage.** Where a recorder hears a site from would be the
  recorder's location, so it isn't kept.

**What's in range of (lat, lon)** is answered from the transmitters
(`site_transmitters`), nearest first, and the point is not stored. Weak identities
are scoped to the H3 resolution-3 region of a system's towers.
- **States and counties** are derived from the location (point in polygon,
  FIPS) when a record is written, for browsing by place. They're labels, never
  structure: a regional system spans counties, and that's fine.

## Sharing from Trunk Recorder Pro

A **Share** button on a system's (or conventional system's) card in Setup. After the
first time it can be "Keep it up to date", which re-shares weekly while the system is
being recorded. Only systems actively recorded can be shared, as decided. The dialog
says exactly what goes and what doesn't.

What's sent is an **Observation**: config in TRP's own terms, plus evidence from the
recorder's own decode.

| Part | Contents |
|---|---|
| System | `type`, `name`, `fcc` map, band plan, its sites' `controlChannelsHz` / `expect` / `voiceChannelsHz` / `modulation` / `lcnTableHz` / colour code / RAN |
| Talkgroups | The talkgroup CSV rows (number, alpha tag, description, mode, tag, category) |
| Evidence | Identity heard (from status), control channels in use and alternates heard, voice frequencies granted with counts, talkgroups granted with counts and encryption seen, neighbours, patches, call signs heard, and decode quality (control messages per second, error rate) for each site |
| Where | Nothing. The region weak identities are matched in comes from the towers the share is placed at. |
| Provenance | App version, anonymous recorder ID (a random ID kept by the install), share time |
| **Never** | Encryption keys, plugin settings and API keys, unit names or aliases (radio IDs are personal), recordings, paths, the short name's folder, other systems |

On the server:
1. The observation is stored as it came: immutable, the audit trail.
2. The matcher resolves it to records through identity claims.
3. It produces a **change set**.
4. Facts from the air are applied automatically when they confirm or add:
   - a control channel or voice channel;
   - talkgroup "heard" stats;
   - a call sign at a frequency.
5. What a person wrote (names, descriptions, tags) becomes an *assertion* on that
   field. Which value shows is decided as in [Merging shares](#merging-shares-and-disagreements).
6. Confidence rises with:
   - independent recorders (different IDs);
   - recency;
   - agreement with the FCC.

Every change the observation causes is one **change set**, so the whole share can be
seen and reverted as a unit ([Versioning](#versioning-and-revert)).

## Bringing it into Trunk Recorder Pro

- **Find systems:** a step in the setup guide, and a button on the Systems tab.
  - **Location:** it uses the location flow #59 built (browser location or typed).
    The point is sent to ask what's near it, and is not stored.
  - **Results:** a list in range: name, type, distance, observed reception, whether
    the user's radios cover its band, and talkgroup count.
  - **Adding one:** creates the system, its sites, its talkgroup file and its `fcc`
    map, then runs the existing coverage and source checks.
- **The survey meets the directory:** when the survey identifies a control channel,
  TRP looks its identity up by claim. "This is DC Fire and EMS: 3 sites, 412
  talkgroups. Add it with its talkgroups?"
- **The link:** an added system keeps `directory: { id, rev }` in its config, and each
  site its site ID. That's how TRP knows what it's tracking, and what a later share
  updates.
- **Updates:**
  - TRP checks a linked system's `rev` (cheap, with an ETag) daily.
  - It shows what's new: talkgroups added or renamed, a control channel added.
  - Applying keeps the user's own edits. Local changes are a layer over the
    directory's (the same "never over the user's" rule as `fcc`'s `from`).
- **Heard but not listed:** a recorder sharing a system also says which talkgroups it
  heard that the directory lacks. That's how unnamed talkgroups get found.

## Browsing on the website

The site is for looking things up, checking what the directory says before
adding it, and fixing it. Location comes first, but every field a record has can be
searched.

### Finding a place

- **A search box that takes anything:**
  - an address, city or ZIP;
  - a county ("Arlington County, VA");
  - coordinates;
  - "near me" (browser location, with the same explanation as in TRP).
- **What's needed for it:**
  - Place names, ZIPs and county shapes come from the Census Bureau's public domain
    gazetteers and TIGER boundaries, loaded into D1.
  - Street addresses go through the Census geocoder, which is free and keyless.
  - Nothing goes to a commercial geocoder.
- **The map:** MapLibre with OpenStreetMap vector tiles, served from R2 as one PMTiles
  file. That's cheap, and has no per-view fees.
  - Sites are drawn as their licensed towers.
  - Conventional channels are grouped by agency.
  - Moving the map updates the list beside it.

**As built:** "Near me" (`/`), the national map (`/map`), browse (`/browse/ST/county/place`)
and search, all filtered by type with every choice in the URL. The page sends only a
location rounded to ~3 km; distances and the reception estimate (Okumura–Hata from each
transmitter's licensed ERP and height, no terrain, drawn as a footprint on a grid) are
computed in the browser. A system with transmitters in 4 or more of a state's counties
is listed once as regional rather than under each. The licensed-but-not-shared layer
comes from the FCC data directly (trunked radio services, and FB8 relays of any). Street
addresses and ZIPs aren't searched yet; counties and cities are.

### The results list and its filters

A location gives the list of systems and agencies in range, ranked as in
[Geography](#geography). Its filters (facets) narrow it, and are kept in the URL, so a
search can be shared or bookmarked.

| Filter | Values |
|---|---|
| Kind | Trunked system, site, conventional channel, agency |
| Protocol | P25 Phase 1 / Phase 2, SmartNet, DMR (Tier III, Capacity Plus, Connect Plus, conventional), NXDN, analog FM, AM |
| Band | VHF low/high, UHF, 700, 800, 900, airband — and "what my radios cover" (a frequency range, or the bands of a TRP config) |
| Service | The fixed service tags: Law Dispatch, Fire Dispatch, EMS, Interop… |
| Reception | Heard here by recorders · predicted only · not heard in 30 days |
| Freshness | Last heard within a day / week / month / year; retired |
| Encryption | Clear, mixed, fully encrypted (as heard) |
| Confidence | Confirmed by several recorders · one recorder · FCC only |

### Searching by anything else

One search covers names, descriptions, talkgroup alpha tags, agencies and call
signs. It uses D1's SQLite full-text index (FTS5), and reads typed values:

| Typed | Found |
|---|---|
| `858.9875`, `155.4` | Frequency uses on it (exact, or a range for a prefix): control and voice channels, conventional channels, FCC licenses |
| `WPXT459` | That call sign: its FCC record, every frequency it's on, the systems and channels using it |
| `BEE00.3A9`, `NAC 443`, `sysid 3a9` | Systems and sites by identity |
| `TG 716`, `716` within a system | Talkgroups by number |
| Words | Systems, agencies and talkgroups by name or description, best match first, then nearest when there's a location |

### Pages

Each page has a permanent URL by ID; a merged ID redirects.
- **Place** (state, county, city): the systems and agencies in it, as a list and a map.
- **System:**
  - an overview: name, type, identity, network, sites on a map, last heard,
    confidence;
  - **Sites:** control channels, alternates, the voice channels it grants, neighbours,
    licenses;
  - **Talkgroups:** a table to sort, filter and search by number, name, tag, category,
    "heard in the last 30 days" and encryption;
  - **Licenses:** the `fcc` map, joined to the FCC records;
  - **History** ([Versioning](#versioning-and-revert));
  - **Add to Trunk Recorder Pro** and **Download** (below).
- **Site, talkgroup, agency, channel:**
  - a talkgroup's page shows its name over time, and which sites it's heard on;
  - an agency's page shows its channels, licenses and systems.
- **Call sign:** the FCC license (licensee, locations, frequencies), and where it's used
  in the directory.

### From the website into TRP

- **Add to Trunk Recorder Pro:**
  - The browser version at trunkrecorder.pro/app is on the same site, so it imports
    directly.
  - For the desktop app, the button opens the user's own TRP
    (`http://localhost:8080/#import=sys_…`, its address remembered by the browser).
  - TRP then fetches the system itself, and shows what it will add before adding it.
- **Download:**
  - TRP `System` JSON with its talkgroup CSV;
  - a Trunk Recorder `config.json` fragment;
  - a talkgroup CSV;
  - later, other formats (SDRTrunk playlist).

Pages are rendered at the edge by the Worker, so they're quick and search engines
can index them. The same JSON API backs them.

## Roles and moderation

RR relies on one volunteer administrator per state who reviews every submission.
Here most changes need no one, because the air confirms them, so people are needed
only where judgement is.

| Role | Who | Can |
|---|---|---|
| Anyone | No account | Browse, search, download. Share from TRP (as an anonymous recorder ID). Flag something as wrong. |
| Contributor | An account (GitHub, or email) | Edit names, descriptions and tags (as suggestions, or directly once trusted); vote between names; place a site on the map |
| Steward | A contributor given a system, a network, or a region (cells / counties) | Accept or reject suggestions, settle disagreements, **lock** a field, merge and split records there, retire what's gone, revert there |
| Admin | A few people | Everything, everywhere: roles, bans, quarantining a recorder ID, bulk revert, hiding records, takedowns, the audit log |

**Trust.** A contributor whose edits last (not reverted, matching later shares) gets
direct edits for that system after a while. Stewards are chosen from them, the
way RR's administrators come from active contributors, but per system or region rather
than per state.

**Review queue** (for stewards and admins), with the reason for each item:
- Disagreements no rule settled ([below](#merging-shares-and-disagreements)).
- Matches in doubt: an observation that fits two records, or nothing.
- Suggestions from untrusted contributors.
- Flags from readers.
- **Staleness:**
  - a control channel, site, talkgroup or channel not heard by any sharing recorder in
    90 days (while others in the same system are) is proposed for retirement;
  - nothing is retired automatically when no one is listening there at all;
  - retired records stay visible as retired.

**Admin tools:**
- Hide a record: kept, but off the site and API.
- A takedown: hidden, with the legal reason in the audit log.
- Quarantine a recorder ID or an account: its observations stop applying.
- Bulk-revert everything a recorder or account did.

Admin actions are themselves revisions (except what a takedown hides), so they can be
undone. They're all in an audit log that admins can read.

## Merging shares and disagreements

Many recorders will share the same system, and they'll disagree. The rule is **merge
field by field, never record by record**: no share replaces a system. Every share adds
evidence to fields, and each field shows its best-supported value.

### Kinds of field

- **What the air says:**
  - **Which fields:** control channels, voice channels granted, identity, talkgroups
    heard, encryption seen, neighbours, call signs heard.
  - **How shares combine:** the union, with counts and first/last heard.
  - **Conflicts:** there aren't any. Something that stops being heard ages out and
    becomes a retirement proposal.
- **Settings:**
  - **Which fields:** a talkgroup's mode, tag, category, priority; a site's modulation
    and band plan.
  - **How shares combine:** the value most independent sources assert in the last
    year wins.
  - **Exceptions:** a band plan learned from the air beats one typed in. A steward's
    lock beats everything.
- **Text:**
  - **Which fields:** names, alpha tags, descriptions.
  - **How shares combine:** candidate values, each with its supporters (below).

### Only edits count, not echoes

Most recorders that share a system will have imported it from the directory. If their
copy of a name counted as a vote, the first name entered would win forever. So:
- A share carries the directory `rev` its system came from.
- The server compares the share with that revision.
- Only what the user **changed** counts as an assertion: a renamed talkgroup, a new one,
  a tag changed.
- What's unchanged counts only as weak confirmation that the value is still right.
- A system typed in by hand (not imported) asserts everything, once.
- Leaving a talkgroup out is **not** a vote to delete it. People prune their lists to
  what they want to hear. Deleting is something a steward does, or the air
  (never heard, then retired).

TRP tracks each talkgroup row's source for this: typed, from the air, from the
directory, or pasted from RR. RR rows are never shared, as already decided.

### Choosing between names

Each text field has a list of **candidates**, and each candidate has its
**supporters**: independent recorders or accounts, with when they asserted it, and the
trust of each.
- **What shows:** the candidate with the most support over the last year
  (each supporter weighted by trust, and decaying with age).
- **Hysteresis:** a challenger must lead the current value by a margin (say two
  independent supporters, or one steward) to replace it. That stops names flipping
  back and forth between two camps.
- **A lock:** a steward can lock a field to a value. Shares asserting another value
  still add candidates, but don't change it. A lock is shown, with who set it and why.
- **Close calls:** a close race (two candidates within the margin, each with several
  supporters) goes into the review queue.

**On the page,** the talkgroup shows the chosen name. A small **"2 names"** shows the
others, with their support, and a contributor can back one or add another. Nothing a
user typed is thrown away; it stays as a candidate with its supporters.

**In TRP,** a user who renamed a talkgroup keeps their name. Their local layer wins
on their machine, whatever the directory shows.

## Partial views: big systems and duplicate records

No recorder sees a whole statewide system. Each hears one site, or a few. The system in
the directory is built from many partial views, and the design has to make that the
normal case, not an exception.

### Shares attach at the site, not the system

The matcher resolves a share **site first**:
1. **The site's own claim** (`p25:{WACN}.{SysID}/{RFSS}.{Site}`, and its control
   channels in the same region) finds the site if the directory has it. The share's
   facts go onto that site.
2. **A new site of a known system:** the system claim (WACN.SysID, or the weaker
   per-protocol claims) finds the system. The share **adds a site to it**, not a
   new system.
3. **Only when neither matches** is a new system made, and then it's provisional
   ([below](#duplicates-and-how-they-get-merged)).

So a statewide P25 system assembles itself. Every recorder adds its own site's control
channels, voice channels, talkgroups heard and call signs to the same system. Nobody
needs to have seen it all.

### The air already describes the rest of the system

A P25 control channel announces its neighbours (adjacent site status: their RFSS,
site and control channel). SmartNet and NXDN have their own forms of this. TRP already
decodes them (the Decode page's *Neighbouring sites*).
- **A neighbour no one is recording** becomes an **announced site**: its identity and
  control channel, marked *announced, not heard*. Its FCC license (the control
  channel's frequency, near the announcing site) gives its location.
- **The system's map:** one recorder's share draws its own site and the ring around it.
  Shares from elsewhere fill in further rings.
- **The whole system:** after a few, the system's map is complete, including sites no
  one has ever recorded.
- **Announcements as links:** each announcement also records which site announced
  which. That is strong evidence for merging (below).

### Talkgroups on a big system

A talkgroup number is the same talkgroup across a system: TG 716 is one talkgroup at
every site.
- **Where names come from:** a name contributed by someone near one site applies
  system-wide. Its supporters are counted system-wide too.
- **Per-site evidence:** what's heard stays per site. Each talkgroup knows the sites
  it's been granted on, with counts and last heard.
- **The system's talkgroup list** is the union of all of them.

That makes a better import possible:
- **Choosing sites:** adding a statewide system in TRP starts from the user's location.
  It pre-selects the sites in range (observed coverage first, then predicted), and the
  user can change the selection.
- **Choosing talkgroups:**
  - **Default:** the talkgroups **heard at those sites**, plus those heard system-wide
    (statewide interop, tagged as such), instead of thousands of statewide talkgroups.
  - **On request:** "All talkgroups".
- **Sharing it back** then covers only the user's sites, and merges into the system
  cleanly.

### Duplicates, and how they get merged

Duplicates happen when the air's identity is weak or ambiguous, and recorders far apart
each see part of a system:
- P25 on the default WACN (BEE00) whose SysID is also used elsewhere: the claim is
  scoped by region, so two far-apart observations make two records.
- SmartNet, DMR Tier III, and NXDN system codes, which repeat across the country.
- DMR Capacity Plus and other systems with no system ID on the air.
- A system first typed in by hand, and later shared from the air.

Splitting them by region is right when they really are different systems. It's wrong
when they're the same one, seen from both ends. A background job looks for
**evidence that two records are one system**, scores it, and either merges them or
proposes the merge.

| Evidence | Strength | Why |
|---|---|---|
| A site of one is announced as a neighbour by a site of the other, with matching identity | Decisive | The system itself says they're one |
| One TRP config records sites of both as one system (a user's multi-site system) | Strong | Someone hears both, and decodes them as one |
| The same WACN.SysID, WACN not the default | Decisive | Globally unique enough |
| The same SysID on the default WACN, regions next to each other, with heavy talkgroup overlap (numbers *and* names) | Strong | Same numbering and same names isn't chance |
| The same FCC licensee on both sides' control channels | Supporting | One licensee often runs one system |
| Overlapping talkgroup numbers only | Weak | Numbering schemes repeat |
| The same SysID, far apart, no other evidence | None | Probably different systems: leave them |

- **Decisive evidence** merges automatically, as a change set anyone can see and a
  steward can revert.
- **Strong evidence** goes into the review queue as a proposed merge, with the
  evidence shown and both systems drawn on one map.
- **Anyone can propose one.** A contributor can propose a merge ("these are the same
  system") with a reason; a steward decides.

### What a merge does

A merge is one change set, so it can be reverted (see [Reverting](#reverting)):
- **Which ID stays:** the older record, or the one with more sites. The other becomes a
  redirect.
- **Sites:**
  - unioned;
  - two sites with the same site claim merge as well, and their frequency uses and
    counts add up;
  - an announced site that turns out to be a heard site is filled in, not duplicated.
- **Talkgroups:**
  - matched by number within the system;
  - for each matched talkgroup, both records' candidates and supporters for every field
    are pooled, and the choice is made again;
  - nothing either side contributed is lost;
  - where both sides had different names well supported, it goes to the review queue
    as a disagreement, not decided silently.
- **Locks:** two locks on one field with different values go to review. No lock is
  dropped silently.
- **Licenses and coverage** are unioned.
- **Networks:** if the two had different SysIDs (statewide regions under one WACN), the
  result isn't one system. They become **two systems in one network**. The question
  is whether TRP records them as one system or two, so it's a choice, not a merge.
- **History:** the surviving system's history shows "merged from sys_… at rev 412", and
  both histories are browsable from there.

### What linked recorders see

- A recorder linked to the record that went away gets a **"merged into sys_…"**
  answer at its next update check (the API answers the old ID with a redirect). TRP then:
  - relinks the system;
  - keeps the user's sites and edits;
  - offers what's new: "This system has 14 more sites; 3 are in range of you".
- A recorder linked to the surviving record just sees a newer `rev`.
- Its later shares go to the merged system, by the same site-first matching.

### When a merge was wrong

- **Reverting the merge's change set** restores both records with their own IDs,
  sites, talkgroups and candidates. Changes made after the merge are kept where they
  can be attributed (a share to a site goes back with that site's system). Fields
  that can't be attributed go to review.
- **A split:** a steward picks which sites go to the new record. Talkgroups are copied
  to both, with their per-site evidence divided by site. The split is one change set,
  so it can be reverted too.
- **A pair marked "not the same system"** is never proposed again unless new decisive
  evidence comes.

## Versioning and revert

Nothing is ever overwritten. The directory is **append-only**:
- every change is a revision that records the field's value before and after;
- the tables people read from are a materialized view of the latest revisions.

### Revisions, change sets, versions

- **A revision** is one field of one record changing: before, after, why, by whom
  (air, FCC, a recorder, a contributor, a steward, an admin), and from which
  observation.
- **A change set** is the revisions one action made, applied together:
  - one share;
  - one edit on the website;
  - one merge;
  - one revert.
- **A system's version (`rev`)** goes up by one with each change set touching the
  system, its sites or its talkgroups. That's the `rev` TRP links to.
- **Snapshots:** the whole system as JSON (sites, talkgroups, licenses) is stored in R2
  every 50 revisions, and at every merge or split. With them, "the system as of rev
  412" is a snapshot plus a few revisions, not a replay from the start.

### Seeing history

- **A system's History tab:** change sets newest first ("Recorder r_…: 3 talkgroups
  added, 1 renamed"; "Steward Alex: locked TG 716's name"), each expandable to its
  field changes.
- **Comparing two versions:** a diff of what was added, removed or changed in sites,
  talkgroups and licenses.
- **A talkgroup's timeline:** its names over time, with who changed each.
- **Viewing an old version:** the page as it was at any rev, read-only.

### Reverting

- **One change set:** a new change set that undoes it. Each field is put back
  *if no later change touched it*; otherwise that field is listed as a conflict for a
  steward to decide. A revert is itself a change set, so it can be reverted.
- **Back to a version:** puts every field changed since rev N back to its value at N,
  as one change set ("Reverted to rev 412"). Later candidates and supporters are kept,
  so nothing is lost, only no longer shown.
- **Everything someone did** (vandalism): an admin reverts every change set from one
  recorder ID or account, across systems.
- **Merges and splits:** these are change sets too, so reverting one restores both
  records and their IDs. A redirect stops being one.
- **Deleted records:** there are none. A retired, hidden or merged record is a tombstone
  that can be restored.

For TRP, a revert is just a newer `rev` with the old values. A linked recorder sees a
normal update, and its user's own edits are untouched, as with any update.

## API (`/directory/api/v1`)

| | |
|---|---|
| `GET /systems?cell=…&radiusKm=…&bands=…&tags=…` | What's in range (the location is a cell, never a point) |
| `GET /systems/{id}` | The system, its sites, licenses and locations, and its `rev` (ETag) |
| `GET /systems/{id}/talkgroups` (`.json` / `.csv`) | Talkgroups in TRP's CSV format, or JSON with "heard" stats |
| `GET /systems/{id}/config` | Ready to merge: TRP `System` JSON plus its talkgroup CSV (exports for Trunk Recorder and SDRTrunk later) |
| `GET /identify?claim=p25:BEE00.3A9/1.5` | Records matching what the air says (the survey's lookup) |
| `GET /channels?cell=…&radiusKm=…` | Conventional channels and collections in range |
| `POST /observations` | A share from TRP: an anonymous recorder ID, rate limited |
| `GET /systems/{id}/history` | Change sets, with what each came from |
| `GET /systems/{id}?rev=412`, `GET /systems/{id}/diff?from=400&to=412` | A system as it was, and what changed between two versions |
| `GET /search?q=…&cell=…&facets…` | Search and filters, as on the website |
| `POST /suggestions`, `POST /votes`, `POST /flags` | Contributors' edits, backing a candidate, flagging (account) |
| `POST /changesets/{id}/revert`, `POST /systems/{id}/revert?to=412`, `POST /locks` | Stewards and admins |
| `POST /merges` (propose, with evidence), `POST /merges/{id}/accept`, `/reject` ("not the same"), `POST /systems/{id}/split` | Merging and splitting |
| `GET /systems/{id}/talkgroups?sites=…` | Talkgroups heard at those sites (plus system-wide ones), for importing part of a big system |

Each `GET` is cacheable at Cloudflare's edge per cell and per system. `/fcc/identify`
and `/fcc/callsigns` stay as they are.

## Storage

D1 holds the records. Observations go to R2 as JSON, with an index row in D1, so the
database stays small. A sketch of the tables:

```
networks(id, kind, wacn, name, …)
systems(id, network_id, type, name, rev, created, updated, confidence)
sites(id, system_id, name, rfss, site, nac, modulation, bandplan, lat, lon, loc_source, status /* heard|announced|retired */, …)
site_neighbours(site_id, neighbour_site_id, first_announced, last_announced)
talkgroup_sites(talkgroup_id, site_id, grants, first_heard, last_heard)
merge_proposals(id, a_id, b_id, evidence_json, score, status /* open|merged|rejected */, decided_by, changeset_id)
site_freqs(site_id, freq_hz, use /* control|alt|voice|repeater */, first_heard, last_heard, grants)
fcc_licenses(owner_kind, owner_id, freq_hz, call_sign, name, source)
talkgroups(id, scope_kind, scope_id, number, alpha, description, mode, tag, category, priority, enc_seen, first_heard, last_heard, grants)
agencies(id, name, fcc_name, lat, lon, …)
channels(id, freq_hz, access, mode, bandwidth, input_hz, scope, lat, lon, …)
channel_agencies(channel_id, agency_id) / channel_talkgroups(channel_id, …)
claims(kind, key, record_kind, record_id, observations, first_seen, last_seen)
geo_cells(cell, record_kind, record_id, source, strength)
redirects(old_id, new_id)
changesets(id, at, actor_kind /* air|fcc|recorder|contributor|steward|admin */, actor_id, kind /* share|edit|merge|split|revert|lock|retire|hide */, observation_id, reverts_id, note)
revisions(id, changeset_id, record_kind, record_id, field, before_json, after_json)
system_revs(system_id, rev, changeset_id)        /* what each version of a system was */
snapshots(system_id, rev, r2_key)
candidates(record_kind, record_id, field, value, first_at, last_at, score)
supporters(candidate_id, actor_kind, actor_id, at, base_rev, weight)
locks(record_kind, record_id, field, value, by, at, reason)
observations(id, recorder_id, cell, at, app_version, base_rev, r2_key, status)
accounts(id, provider, handle, trust, created) / roles(account_id, role, scope_kind, scope_id)
flags(id, record_kind, record_id, by, at, reason, status)
search_fts(record_kind, record_id, text)       /* FTS5 */
places(id, kind /* state|county|place|zcta */, name, fips, lat, lon, cells)
```

ArgusRF's `argus` D1 database stays its own. The directory gets its own D1 database
(`trp`, as reserved), and joins to the FCC data through the API, not SQL.

## Abuse, privacy and licensing

- **Shares:** sharing from TRP needs no account. A share is signed with the install's
  random recorder ID and rate limited per ID and per IP. Roles are in
  [Roles and moderation](#roles-and-moderation).
- **Sensitive systems:**
  - Federal and encrypted systems are listed as heard, and their talkgroups numbered.
  - A takedown policy is needed from day one. RR has a history of legal demands (for
    example a Section 605 demand from a trunked operator).
  - A record can be hidden without being deleted.
- **Privacy:**
  - No point locations from recorders.
  - No radio IDs or aliases.
  - Recorder IDs never shown.
  - Cells only when the user gave a location, and the share dialog says so.
- **Licensing:**
  - The directory's data under an open license. ODbL, or CC BY-SA, is a decision to make.
  - FCC data is public domain.
  - **Nothing from RadioReference, ever:** not imports, and not users' pasted RR
    tables. TRP's RadioReference talkgroup paste stays a local convenience, and
    talkgroups that came from a paste aren't shared unless the user confirms they're
    their own. That needs a `source` on talkgroup rows, which TRP doesn't track yet.

## Phases

1. **Read-only seed.** Schema, IDs, claims, H3 index. Seed agencies and channel
   locations from FCC ULS for public safety (no people yet). `/identify` and
   `/systems?cell` work on whatever exists.
2. **Share from TRP.**
   - The Share button, observations, the matcher (site first), auto-applied air facts.
   - Announced sites from neighbour lists. Talkgroups heard per site.
   - Merges from decisive evidence, as revertable change sets.
   - **Revisions, change sets and `rev` from the first write.** History can't be added
     later.
   - Candidates and the "only edits count" rule.
   - A minimal web page per system: sites, talkgroups, licenses, last heard.
   - Admin basics: hide, revert a change set, quarantine a recorder.
3. **Find and add in TRP.**
   - The directory step in the setup guide.
   - The survey matched to the directory.
   - `directory: {id, rev}` links, which follow merge redirects.
   - Choosing sites and talkgroups for a big system.
4. **Updates.** Update checks, diffs, local override layers. "Heard, not named"
   talkgroups for reviewers.
5. **Browsing.** The map, place search, filters, full-text search, place pages,
   talkgroup timelines, diffs between versions. Coverage from reception (observed cells)
   and ranking by it.
6. **People.**
   - Accounts, suggestions and votes, stewards and locks.
   - The review queue, staleness proposals.
   - Proposed merges (strong evidence), "not the same system", splits.
   - Bulk revert, takedowns.

## Open questions

- **Network or system?** When does a WACN with several SysIDs become one TRP system
  (multi-site), and when several? It's probably the user's choice at import, with the
  directory keeping the network.
- **Talkgroup scope:** statewide talkgroups live on the network, but each TRP system
  needs its own CSV. Should export flatten network talkgroups into each system's file?
- **H3 resolution:** 6 is about 36 km² a cell, fine for privacy and ranking. Is 5
  (about 250 km²) better for the privacy of rural users?
- **Licensing:** ODbL vs CC BY-SA, and how to credit contributors.
- **Re-sharing cadence:** weekly, and the cost of storing observations in R2 at scale.
- **Talkgroup sources in TRP:** a talkgroup's `source` (typed in, from the air, RR
  paste, directory) is needed before talkgroups can be shared safely.
- **Merge thresholds:** how many shared talkgroup names make "heavy overlap", and how
  near "regions next to each other" is. Start with everything except decisive evidence
  going to review.
- **A Network in TRP:** when a statewide network has several SysIDs, should TRP gain a
  way to record them as one system (sites from different SysIDs), or keep them
  separate? The engine's multi-site support today expects one system's sites.
- **Choosing names:** the margin, the decay (a year?) and trust weights need tuning
  on real shares. Start strict (a steward decides close calls) and loosen.
- **Stewards:** who appoints the first ones, and for what scope (a system, a county, a
  state)? Is it invitation only to begin with?
- **Accounts:** GitHub only (easy, and fits the project), or email too?
- **Search engines:** should the site be indexed? It's good for finding systems, but
  may draw takedown attention.
- **SmartNet and DMR identity:** how big the region is before claims collide. This
  needs real data from sharing recorders.
