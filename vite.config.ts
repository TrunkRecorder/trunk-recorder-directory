// The website, served by the Worker under /directory/ (dist/directory/).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "/directory/",
  plugins: [react()],
  build: { outDir: "../dist/directory", emptyOutDir: true },
  server: { proxy: { "/directory/api": "http://localhost:8790" } },
});
