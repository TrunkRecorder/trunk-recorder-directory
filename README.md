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
- **Partial views add up:**
  - a share is matched site first, so recorders hearing different sites of a statewide system build one system;
  - two records found to be one system (by their identity, or by one announcing the other's site) are merged, and
    the merge can be reverted.

The design, and what isn't built yet, is in [docs/design.md](docs/design.md).

It lives on a path of trunkrecorder.pro. The landing page stays its own static site
([trunk-recorder-pro-site](https://github.com/TrunkRecorder/trunk-recorder-pro-site)), and the FCC license lookup stays at
`/api/v1/fcc` (trp-api).

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
| `src/geo.ts` | H3 cells (D1 has no spatial index) |
| `migrations/` | The D1 schema |
| `web/` | The website (React, Vite), built into `dist/directory/` |

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

All under `/directory/api/v1`. Reads are open. A share needs no account: it carries the install's anonymous recorder ID,
and is rate-limited. Stewards' and admins' actions need `ADMIN_TOKEN` (bearer) until there are accounts.

| | |
|---|---|
| `GET /systems?lat=&lon=&radiusKm=` (or `cell=`, an H3 resolution-6 cell) | Systems heard in range |
| `GET /systems/{id}[?rev=]` | A system (as it was at a version); a merged ID redirects (301) to the system it went into |
| `GET /systems/{id}/talkgroups[.csv][?rev=&sites=]` | Its talkgroups, with where each is heard and the other names people gave; `sites=`: what's heard there |
| `GET /systems/{id}/config[?sites=]` | Ready for TRP: its `System` (with `directory: {id, rev}`) and talkgroup CSV |
| `GET /systems/{id}/history`, `GET /systems/{id}/diff?from=&to=`, `GET /changesets/{id}` | Versions, a diff between two, one version's changes |
| `GET /search?q=[&system=]` | By frequency (`857.9875`), call sign, identity (`BEE00.3A9`), talkgroup number in a system, or words |
| `GET /identify?claim=p25:bee00.3a9/1.5` | What an identity heard on the air is |
| `POST /observations` | A share from TRP (`src/observation.ts`) |
| `POST /changesets/{id}/revert`, `POST /systems/{id}/revert {to}`, `POST /actors/{id}/revert` | Revert (token) |
| `POST /merges {a, b, why}`, `GET /merge-proposals`, `POST /merge-proposals/{id}/reject` | Merging (token) |
| `POST /locks {id, field, value, reason}`, `POST /quarantine {actor, reason}`, `POST /systems/{id}/hide` | Moderation (token) |

## Deploying

```bash
npm run deploy:staging       # checks, then staging; then its end-to-end tests (writes included)
npm run deploy:production    # checks and staging's end-to-end tests, then production; then its tests (reading only)
```

`scripts/deploy.ts`:
1. Runs the checks first: typecheck, tests, the site's build.
2. Makes the D1 database and R2 bucket if they're missing, and records the database ID in `wrangler.toml`.
3. Applies the migrations, then deploys.
4. Makes the `ADMIN_TOKEN` the first time.
5. Tests what it deployed.

URLs and admin tokens are kept in `.deploy.env` (not committed).

| | Worker | D1 | R2 |
|---|---|---|---|
| production | `trunk-recorder-directory` on the route `trunkrecorder.pro/directory*` | `directory` | `trp-directory-observations` |
| staging | `trunk-recorder-directory-staging` on workers.dev | `directory-staging` | `trp-directory-observations-staging` |

The landing page (trunkrecorder.pro, a custom-domain Worker) is untouched. The route on `/directory*` takes those
paths, and `test:production` checks that both are right.

## License

MIT for the code. The data's license (open: ODbL or CC BY-SA) is still to be decided. See docs/design.md.
