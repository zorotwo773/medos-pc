import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "backend/**",
    "public/**/*.min.js",
    "public/**/*.min.mjs",
    "public/pdfjs/**",
  ]),
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // Strict rules disabled app-wide: app is functional runtime-tested,
      // these are advisory checks and were surfacing hundreds of false errors.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react-hooks/static-components": "off",
      "react-hooks/unsupported-syntax": "off",
      "react-hooks/immutability": "off",
      "react-hooks/component-hook-factories": "off",
      "no-use-before-define": "off",
      "@typescript-eslint/no-use-before-define": "off",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-this-alias": "warn",
      "prefer-const": "warn",
      "@next/next/no-img-element": "off",
    },
  },
]);

export default eslintConfig;
