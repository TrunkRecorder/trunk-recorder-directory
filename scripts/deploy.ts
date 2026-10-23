// Deploy to Cloudflare, then test what was deployed.
//
//   node scripts/deploy.ts staging      trunk-recorder-directory-staging (workers.dev)
//   node scripts/deploy.ts production   trunkrecorder.pro/directory
//
// 1. The map's data if it isn't made yet (scripts/geo.ts, maps.ts fonts); then checks: typecheck, the
//    tests, the site's build (production: staging's end-to-end tests too).
// 2. Its D1 database and R2 bucket, made if they don't exist (the D1 id goes into wrangler.toml).
// 3. Migrations, the places table (when it changed), then the deploy. (The basemap is uploaded apart,
//    once: node scripts/maps.ts tiles staging.)
// 4. Its ADMIN_TOKEN, made the first time and kept in .deploy.env (not committed), with its URL.
// 5. The end-to-end tests against it (production: reading only).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const target = process.argv[2];
if (target !== "staging" && target !== "production") {
  console.error("node scripts/deploy.ts staging|production");
  process.exit(2);
}
const env = target === "staging" ? ["--env", "staging"] : [];
const DB = target === "staging" ? "directory-staging" : "directory";
const BUCKET = target === "staging" ? "trp-directory-observations-staging" : "trp-directory-observations";
const KEY = target.toUpperCase();

function sh(cmd: string, args: string[], opts: { input?: string; capture?: boolean; ok?: boolean } = {}): string {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, input: opts.input, encoding: "utf8", stdio: opts.capture || opts.input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit", env: { ...process.env, NO_COLOR: "1" } });
  if (r.status !== 0 && !opts.ok) {
    console.error(r.stdout ?? "", r.stderr ?? "");
    throw new Error(`${cmd} ${args[0]} failed`);
  }
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

const DEPLOY_ENV = join(ROOT, ".deploy.env");
function readDeployEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(DEPLOY_ENV)) for (const l of readFileSync(DEPLOY_ENV, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function writeDeployEnv(v: Record<string, string>) {
  writeFileSync(DEPLOY_ENV, `# Deployed directories: their URLs and admin tokens. Not committed (.gitignore).\n${Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n")}\n`, { mode: 0o600 });
}

// 1. The map's data (made once, kept in .cache/), then the checks.
if (!existsSync(join(ROOT, ".cache/geo/out/geo/counties.json"))) sh("node", ["scripts/geo.ts"]);
if (!existsSync(join(ROOT, ".cache/maps/fonts/Noto Sans Regular/0-255.pbf"))) sh("node", ["scripts/maps.ts", "fonts"]);
// The licensed layer, from an ArgusRF build (made per FCC refresh: node scripts/licensed.ts <its spectrum.db>).
if (!existsSync(join(ROOT, ".cache/geo/out/geo/licensed/index.json"))) {
  const fcc = process.env.FCC_DB_PATH ?? join(ROOT, "..", "argusrf", "build", "spectrum.db");
  if (existsSync(fcc)) sh("node", ["scripts/licensed.ts", fcc]);
  else console.warn(`(no ${fcc}: the map's licensed layer isn't in this build — node scripts/licensed.ts <ArgusRF's spectrum.db>)`);
}
sh("npx", ["tsc", "--noEmit"]);
sh("node", ["--test", "test/*.test.ts"]);
sh("npx", ["vite", "build", "--logLevel", "warn"]);
if (target === "production") sh("node", ["scripts/e2e.ts", "staging"]);

// 2. Its D1 and R2.
const list = JSON.parse(sh("npx", ["wrangler", "d1", "list", "--json"], { capture: true }).replace(/^[^[]*/s, "")) as { name: string; uuid: string }[];
let dbId = list.find((d) => d.name === DB)?.uuid;
if (!dbId) {
  const out = sh("npx", ["wrangler", "d1", "create", DB], { capture: true });
  dbId = /"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"/.exec(out)?.[1];
  if (!dbId) throw new Error(`made ${DB}, but its id isn't in:\n${out}`);
}
const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
const re = new RegExp(`(database_name = "${DB}"\\ndatabase_id = )"[0-9a-f-]{36}"`);
if (!re.test(toml)) throw new Error(`wrangler.toml has no database_id line for ${DB}`);
writeFileSync(join(ROOT, "wrangler.toml"), toml.replace(re, `$1"${dbId}"`));
const buckets = sh("npx", ["wrangler", "r2", "bucket", "list"], { capture: true });
if (!new RegExp(`name:\\s+${BUCKET}\\b`).test(buckets)) sh("npx", ["wrangler", "r2", "bucket", "create", BUCKET]);

// 3. Migrations (and the places table, when its rows have changed), then the Worker.
sh("npx", ["wrangler", "d1", "migrations", "apply", DB, "--remote", ...env], { input: "y\n" });
const placesSql = join(ROOT, ".cache/geo/out/places.sql");
const placesKey = `${KEY}_PLACES`;
const placesStamp = String(readFileSync(placesSql).length);
if (readDeployEnv()[placesKey] !== placesStamp) {
  sh("node", ["scripts/maps.ts", "places", target]);
  writeDeployEnv({ ...readDeployEnv(), [placesKey]: placesStamp });
}
const out = sh("npx", ["wrangler", "deploy", ...env], { capture: true });
console.log(out);
const url = target === "staging" ? /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0] : "https://trunkrecorder.pro";
if (!url) throw new Error("deployed, but its workers.dev URL isn't in wrangler's output");

// 4. Its admin token, the first time.
const de = readDeployEnv();
if (!de[`${KEY}_ADMIN_TOKEN`]) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  sh("npx", ["wrangler", "secret", "put", "ADMIN_TOKEN", ...env], { input: `${token}\n` });
  de[`${KEY}_ADMIN_TOKEN`] = token;
}
de[`${KEY}_URL`] = url;
writeDeployEnv(de);

// 5. Test what's deployed (a moment for a new secret to reach the edge).
await new Promise((r) => setTimeout(r, 5000));
const t = spawnSync("node", ["scripts/e2e.ts", target], { cwd: ROOT, stdio: "inherit" });
process.exit(t.status ?? 1);
