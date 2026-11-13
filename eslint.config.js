import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/out/**", "services/**", "**/coverage/**", ".remember/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Secrets must never reach logs: console is reserved for the CLI entry points.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
);
