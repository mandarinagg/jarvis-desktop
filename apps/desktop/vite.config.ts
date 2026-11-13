import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./", // loaded from file:// by Electron
  plugins: [react()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
});
