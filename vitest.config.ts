import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against workspace sources, no build step needed.
    alias: { "@jarvis/shared": fileURLToPath(new URL("packages/shared/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
