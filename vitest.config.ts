import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against workspace sources, no build step needed. Exact matches only, so
    // subpath imports such as @jarvis/core/client keep resolving through package exports.
    alias: [
      { find: /^@jarvis\/shared$/, replacement: src("packages/shared/src/index.ts") },
      { find: /^@jarvis\/core$/, replacement: src("packages/core/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "evals/src/**/*.test.ts"],
  },
});
