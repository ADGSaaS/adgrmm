// ESLint 9 flat config (Next 16 removed `next lint`; run `npm run lint`, which calls eslint directly).
import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...nextVitals,
  {
    // eslint-plugin-react-hooks 7 (pulled in by eslint-config-next 16) adds React Compiler rules that the previous setup
    // (react-hooks 5: rules-of-hooks + exhaustive-deps only) never ran. The app does not use the React Compiler, so they
    // stay off here; rules-of-hooks and exhaustive-deps keep running as before.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/static-components": "off",
      "react-hooks/incompatible-library": "off",
    },
  },
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "postcss.config.js",
      "tailwind.config.*",
      "next.config.*",
      "*.config.js",
      "*.config.cjs",
      "*.config.mjs",
    ],
  },
];

export default config;
