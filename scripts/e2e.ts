// Run the end-to-end tests (test/e2e) against a running directory.
//
//   node scripts/e2e.ts local        the real Worker offline: `wrangler dev` (workerd, local D1 and R2)
//                                    on a fresh database, writes included
//   node scripts/e2e.ts staging      the staging Worker (workers.dev), writes included
//   node scripts/e2e.ts production   trunkrecorder.pro: reading only (E2E_WRITE=1 to write — don't)
//
// Staging and production read their URL and admin token from .deploy.env
// (not committed; scripts/deploy.ts writes it), or the environment:
// STAGING_URL, STAGING_ADMIN_TOKEN, PRODUCTION_URL, PRODUCTION_ADMIN_TOKEN.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const target = process.argv[2] ?? "local";

function deployEnv(): Record<string, string> {
  const f = join(ROOT, ".deploy.env");
  const out: Record<string, string> = {};
  if (existsSync(f)) for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return { ...out, ...(process.env as Record<string, string>) };
}

function run(cmd: string, args: string[], env: Record<string, string> = {}, quiet = false): Promise<number> {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: quiet ? "ignore" : "inherit", env: { ...process.env, ...env } });
    p.on("exit", (code) => ok(code ?? 1));
  });
}

const tests = () => ["--test", "--test-reporter=spec", "test/e2e/e2e.test.ts"];

async function local(): Promise<number> {
  const port = Number(process.env.E2E_PORT ?? 8799);
  const token = `local-${Math.random().toString(36).slice(2)}`;
  const state = mkdtempSync(join(tmpdir(), "directory-e2e-"));
  try {
    if ((await run("npx", ["vite", "build", "--logLevel", "warn"])) !== 0) return 1;
    // A fresh local D1, migrated as production's is.
    if ((await run("npx", ["wrangler", "d1", "migrations", "apply", "directory-staging", "--local", "--env", "staging", "--persist-to", state], {}, true)) !== 0) {
      console.error("migrating the local D1 failed");
      return 1;
    }
    // The FCC lookup's database: ArgusRF's schema with the fixture's real rows.
    // (By the name wrangler.toml gives FCC_DB: a new one each FCC refresh.)
    const fccDb = /binding = "FCC_DB"\ndatabase_name = "([^"]+)"/.exec(readFileSync(join(ROOT, "wrangler.toml"), "utf8"))?.[1] ?? "argus";
    if ((await run("npx", ["wrangler", "d1", "execute", fccDb, "--local", "--env", "staging", "--persist-to", state, "--file", "test/fixtures/fcc.sql"], {}, true)) !== 0) {
      console.error("loading the FCC fixture into the local D1 failed");
      return 1;
    }
    const dev = spawn("npx", ["wrangler", "dev", "--env", "staging", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state, "--var", `ADMIN_TOKEN:${token}`, "--show-interactive-dev-session=false"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let log = "";
    dev.stdout.on("data", (b) => (log += b));
    dev.stderr.on("data", (b) => (log += b));
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    for (;;) {
      try {
        if ((await fetch(`${base}/directory/api/v1/meta`)).ok) break;
      } catch {}
      if (Date.now() - t0 > 60_000 || dev.exitCode !== null) {
        console.error(`wrangler dev didn't start:\n${log}`);
        dev.kill();
        return 1;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // The places table: the fixture's DC, Virginia and Maryland.
    await run("npx", ["wrangler", "d1", "execute", "directory-staging", "--local", "--env", "staging", "--persist-to", state, "--file", "test/fixtures/places.sql"], {}, true);
    console.log(`wrangler dev (workerd, local D1/R2) on ${base}`);
    // Twice, on the same database: a second run meets the first's data, as staging and production do.
    let code = 0;
    for (let pass = 1; pass <= 2 && !code; pass++) {
      console.log(`\n── pass ${pass} of 2 ──`);
      code = await run("node", tests(), { E2E_BASE_URL: base, E2E_ADMIN_TOKEN: token, E2E_WRITE: "1" });
    }
    dev.kill();
    return code;
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

async function remote(name: "staging" | "production"): Promise<number> {
  const env = deployEnv();
  const url = env[`${name.toUpperCase()}_URL`];
  if (!url) {
    console.error(`No ${name.toUpperCase()}_URL: deploy first (node scripts/deploy.ts ${name}), or set it.`);
    return 1;
  }
  const write = name === "staging" ? "1" : env.E2E_WRITE ?? "0";
  // Ready: the directory itself answers (a new route takes a moment to reach the edge).
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${url}/directory/api/v1/meta`);
      if (r.ok && (await r.json()).v === 1) break;
    } catch {}
    if (Date.now() - t0 > 120_000) {
      console.error(`${url}/directory/api/v1/meta didn't answer as the directory in 2 minutes`);
      return 1;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`${name}: ${url}${write === "1" ? "" : " (reading only)"}`);
  return run("node", tests(), {
    E2E_BASE_URL: url,
    E2E_ADMIN_TOKEN: env[`${name.toUpperCase()}_ADMIN_TOKEN`] ?? "",
    E2E_WRITE: write,
    E2E_LANDING: name === "production" ? "1" : "0",
    // Deployed: the basemap, fonts and boundaries are there too.
    E2E_MAPS: "1",
  });
}

const code = target === "local" ? await local() : target === "staging" || target === "production" ? await remote(target) : (console.error(`local, staging or production, not ${target}`), 2);
process.exit(code);
