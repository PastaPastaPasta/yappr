import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

export default [
  ...compat.extends("next/core-web-vitals", "plugin:@typescript-eslint/recommended"),
  ...compat.config({
    parser: "@typescript-eslint/parser",
    parserOptions: {
      project: "./tsconfig.json",
    },
    plugins: ["@typescript-eslint"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/await-thenable": "warn",
      "@typescript-eslint/no-misused-promises": ["warn", {
        checksVoidReturn: false
      }],
      "react-hooks/exhaustive-deps": "warn"
    },
    ignorePatterns: [
      "node_modules/",
      ".next/",
      "out/",
      "*.config.js",
      "*.config.ts"
    ]
  }),
  {
    ignores: [
      "node_modules/",
      ".next/",
      "out/",
      "*.config.js",
      "*.config.ts",
      "eslint.config.mjs"
    ]
  }
];
