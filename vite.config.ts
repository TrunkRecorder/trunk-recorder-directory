// The website, served by the Worker under /directory/ (dist/directory/).
import react from "@vitejs/plugin-react";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "/directory/",
  plugins: [
    react(),
    // What wrangler mustn't upload from dist/ (Finder's files).
    { name: "assetsignore", closeBundle: () => writeFileSync("dist/.assetsignore", ".DS_Store\n**/.DS_Store\n") },
    // The Census boundaries (scripts/geo.ts) and the map's fonts (scripts/maps.ts fonts), when made:
    // served as files, and read by the Worker for placing sites.
    {
      name: "map-data",
      closeBundle: () => {
        for (const [from, to] of [[".cache/geo/out/geo", "dist/directory/geo"], [".cache/maps/fonts", "dist/directory/fonts"]]) {
          if (existsSync(from)) cpSync(from, to, { recursive: true });
          else console.warn(`(no ${from}: the map has no ${to.split("/").pop()} in this build)`);
        }
      },
    },
  ],
  build: { outDir: "../dist/directory", emptyOutDir: true },
  server: { proxy: { "/directory/api": "http://localhost:8790" } },
});
