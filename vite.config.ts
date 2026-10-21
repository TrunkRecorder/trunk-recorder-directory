// The website, served by the Worker under /directory/ (dist/directory/).
import react from "@vitejs/plugin-react";
import { writeFileSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "/directory/",
  plugins: [
    react(),
    // What wrangler mustn't upload from dist/ (Finder's files).
    { name: "assetsignore", closeBundle: () => writeFileSync("dist/.assetsignore", ".DS_Store\n**/.DS_Store\n") },
  ],
  build: { outDir: "../dist/directory", emptyOutDir: true },
  server: { proxy: { "/directory/api": "http://localhost:8790" } },
});
