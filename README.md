# Trunk Recorder Pro systems directory

The site and API at **[trunkrecorder.pro/directory](https://trunkrecorder.pro/directory/)**: radio systems shared by
Trunk Recorder Pro users, built from what their radios decode. You can browse it by place and search it by anything, and
add a system to Trunk Recorder Pro from it.

- **Structure comes from the air:**
  - control channels, sites and the neighbours they announce;
  - voice channels granted;
  - talkgroups heard, and where;
  - FCC call signs sent on the air.

  Facts that independent recorders confirm are applied automatically.
- **People supply meaning:** names, descriptions and tags. Every value someone gives is kept as a candidate with its
  supporters, and the best-supported one is shown. A challenger needs a clear lead, and a steward can lock a field.
- **Nothing is overwritten:**
  - every change is a revision in a change set;
  - each system has a version (`rev`);
  - any version can be viewed or compared;
  - a change set, a system's history back to a version, or everything one recorder did can be reverted (merges
    included).
- **Where systems are comes from their licenses:** each site's transmitters are the FCC-licensed base and repeater
  stations on its frequencies, found by the call signs it sends on the air, or by its frequencies when it sends none.
  Census boundaries put each one in a state, county and city, so the directory can be browsed by place, and the map
  (the home page) answers "what's here?" and, with your location (yours, a city, a ZIP code), "what can I hear from
  here?" (with a rough reception estimate from each transmitter's power and height).
- **Partial views add up:**
  - a share is matched site first, so recorders hearing different sites of a statewide system build one system;
  - two records found to be one system (by their identity, or by one announcing the other's site) are merged, and
    the merge can be reverted.

The design, and what isn't built yet, is in [docs/design.md](docs/design.md).

It lives on paths of trunkrecorder.pro:
- **`/directory*`:** the directory and its API (`/directory/api/v1`).
- **`/api/v1/fcc/*`:** Trunk Recorder Pro's FCC license lookup, `src/fcc/`.
  - It reads ArgusRF's FCC database (D1 `argus-YYYYMMDD`, a new one each FCC refresh; read only), which
    [robotastic/argusrf](https://github.com/robotastic/argusrf) builds. Placing sites reads it too. After a
    refresh, point `FCC_DB` (both environments, `wrangler.toml`) at the new one and deploy.
  - Its query code and schema are a marked copy of ArgusRF's: copy them again if ArgusRF changes them.

The landing page stays its own static site ([trunk-recorder-pro-site](https://github.com/TrunkRecorder/trunk-recorder-pro-site)).

## Layout

| | |
|---|---|
| `src/worker.ts` | The Worker: the API under `/directory/api/v1`, and the website for the rest of `/directory` |
| `src/api.ts` | The API's routes |
| `src/observation.ts` | What a share from TRP is, and checking one |
| `src/share.ts` | Applying a share: matching (site first), air facts, names, talkgroups |
| `src/claims.ts` | Identity claims: what the air says, as keys (weak ones scoped to a region) |
| `src/names.ts` | Candidates and supporters: which name is shown |
| `src/store.ts` | Change sets and revisions: every write goes through one |
| `src/merge.ts`, `src/revert.ts` | Merging two systems; undoing change sets |
| `src/read.ts` | A system as it is or was, talkgroups, near a place, search, history, diffs, TRP's config |
| `src/place.ts`, `src/places.ts` | Placing sites from FCC licenses; which county and city a point is in |
| `src/explore.ts` | By place (state → county → city), the map's layers, near a point, licensed systems not shared yet |
| `src/tiles.ts` | The basemap: vector tiles from one PMTiles file in R2; uploading it |
| `src/geo.ts` | H3 cells (D1 has no spatial index) |
| `migrations/` | The D1 schema |
| `web/` | The website (React, Vite, MapLibre), built into `dist/directory/` |
| `scripts/geo.ts`, `scripts/maps.ts` | The map's data: Census boundaries and places; fonts; the basemap's extract and upload |

## Developing

```bash
npm install
npm run dev:api        # http://localhost:8790/directory/ on SQLite (directory.db)
node scripts/seed.ts   # a few sample shares into it
```

`npm run dev` rebuilds the site as it changes and serves both.

## Testing

Three levels, all in the repo:

| | What | Where it runs |
|---|---|---|
| `npm test` | Unit and API tests (`test/*.test.ts`): shares, matching, claims, names, change sets, merges, reverts, reading, search, the API's surface, the Worker's routing | In memory (SQLite), seconds |
| `npm run test:local` | The end-to-end tests (`test/e2e/`) over HTTP against **the real Worker offline**: `wrangler dev` (workerd) with local D1 and R2 on a fresh database, the website built, writes included; run twice on one database | Offline, before deploying |
| `npm run test:staging` | The same, against the staging Worker on workers.dev (its own D1 and R2), writes included | Deployed |
| `npm run test:production` | The same, against trunkrecorder.pro, **reading only** (and the landing page still the landing page) | Deployed |

`npm run check` runs the first two. CI runs both on every push. The Production workflow runs
`test:production` every 6 hours.

End-to-end writes use made-up identities (a random WACN) and hide what they made, so they can run again
and again against one database.

## The API

All under `/directory/api/v1`. The exploring reads take `types=p25,smartnet,…` (default: every type). Every read is kept at the edge for a day under the directory's data version (its newest
revision, share and placement: three rows read per request), so a change shows at once and an unchanged answer
costs no D1 reads. Reads are open. A share needs no account: it carries the install's anonymous recorder ID,
and is rate-limited. Stewards' and admins' actions need `ADMIN_TOKEN` (bearer) until there are accounts.

| | |
|---|---|
| `GET /systems?lat=&lon=&radiusKm=` (or `cell=`, an H3 resolution-6 cell) | Systems heard in range |
| `GET /systems/{id}[?rev=]` | A system (as it was at a version); a merged ID redirects (301) to the system it went into |
| `GET /systems/{id}/talkgroups[.csv][?rev=&sites=]` | Its talkgroups, with where each is heard and the other names people gave; `sites=`: what's heard there |
| `GET /systems/{id}/config[?sites=]` | Ready for TRP: its `System` (with `directory: {id, rev}`) and talkgroup CSV |
| `GET /systems/{id}/history`, `GET /systems/{id}/diff?from=&to=`, `GET /changesets/{id}` | Versions, a diff between two, one version's changes |
| `GET /search?q=[&system=&types=]` | By frequency (`857.9875`), call sign, identity (`BEE00.3A9`), talkgroup number in a system, or words (names, licensees); and `places`: a name, "City, ST", "City, State" or a ZIP code, each with a point |
| `GET /places`, `/places/{ST}`, `/places/{ST}/{county}`, `/places/{ST}/{county}/{place}` | By place: states with counts by type; a state's counties and regional systems; a county's systems and cities; a city's systems (Census GEOIDs) |
| `GET /map/sites`, `GET /map/counties` | Every placed site with its transmitters; each county's count of systems |
| `GET /map/callsigns` | The call signs shared systems have (the map leaves them off its licensed layer, which is the site's files: `/directory/geo/licensed/`) |
| `GET /nearby?lat=&lon=[&coarse=1]&radiusKm=` (or `cell=`) | Systems with a transmitter in range, nearest first, with their transmitters (power, height, frequency) |
| `GET /identify?claim=p25:bee00.3a9/1.5` | What an identity heard on the air is |
| `POST /observations` | A share from TRP (`src/observation.ts`) |
| `POST /changesets/{id}/revert`, `POST /systems/{id}/revert {to}`, `POST /actors/{id}/revert` | Revert (token) |
| `POST /merges {a, b, why}`, `GET /merge-proposals`, `POST /merge-proposals/{id}/reject` | Merging (token) |
| `POST /locks {id, field, value, reason}`, `POST /quarantine {actor, reason}`, `POST /systems/{id}/hide` | Moderation (token) |

The FCC lookup, on `trunkrecorder.pro/api/v1/fcc`. It's open, CORS `*`, 30 lookups a minute per IP, and request bodies are never logged:

| | |
|---|---|
| `POST /api/v1/fcc/identify {lat, lon, radiusM?, signals: [{freqHz, widthHz?}]}` | Who is licensed on each frequency near the point (up to 64; 1–150 km), nearest first, each call sign once; `historical` when only lapsed licenses match |
| `POST /api/v1/fcc/callsigns {callSigns: [...]}` | Who holds each active call sign (up to 64), with no location |
| `GET /api/v1/fcc/meta` | The FCC data's date |

## Deploying

```bash
npm run deploy:staging       # checks, then staging; then its end-to-end tests (writes included)
npm run deploy:production    # checks and staging's end-to-end tests, then production; then its tests (reading only)
```

### The map's data

| | Made by | Kept in | Served from |
|---|---|---|---|
| Counties and Census places (2024 cartographic boundaries) and the `places` table | `node scripts/geo.ts` | `.cache/geo/out/` | the site's files (`/directory/geo/`), D1 |
| Label fonts (Protomaps' Noto Sans glyphs) | `node scripts/maps.ts fonts` | `.cache/maps/fonts/` | the site's files (`/directory/fonts/`) |
| The licensed layer: every trunked system licensed in the US, by 1° cell (51,649 spots) | `node scripts/licensed.ts <ArgusRF's spectrum.db>`, per FCC refresh | `.cache/geo/out/geo/licensed/` | the site's files (`/directory/geo/licensed/`) |
| The basemap: Protomaps' OpenStreetMap build, the US to zoom 12 (2.1 GB) | `node scripts/maps.ts extract` (needs `pmtiles`) | `.cache/maps/us.pmtiles` | R2 `trp-directory-maps` (`/directory/tiles/`), one bucket for both |

The deploy script makes the boundaries and fonts if they're missing, and loads the `places` table when it changed.
The basemap is uploaded on its own, rarely (a new extract): `node scripts/maps.ts tiles staging` (through the
Worker, in 64 MB parts; staging and production read the same bucket). Without it the site still works; its maps
have no basemap.

`scripts/deploy.ts`:
1. Runs the checks first: typecheck, tests, the site's build.
2. Makes the D1 database and R2 bucket if they're missing, and records the database ID in `wrangler.toml`.
3. Applies the migrations, then deploys.
4. Makes the `ADMIN_TOKEN` the first time.
5. Tests what it deployed.

URLs and admin tokens are kept in `.deploy.env` (not committed).

| | Worker | D1 | R2 |
|---|---|---|---|
| production | `trunk-recorder-directory` on the routes `trunkrecorder.pro/directory*` and `trunkrecorder.pro/api/v1/fcc/*` | `directory` (and `argus-20261018`, read only) | `trp-directory-observations`, `trp-directory-maps` |
| staging | `trunk-recorder-directory-staging` on workers.dev | `directory-staging` (and `argus-20261018`, read only) | `trp-directory-observations-staging`, `trp-directory-maps` |

The landing page (trunkrecorder.pro, a custom-domain Worker) is untouched. The route on `/directory*` takes those
paths, and `test:production` checks that both are right.

## License

MIT for the code. The data's license (open: ODbL or CC BY-SA) is still to be decided. See docs/design.md.
