import { FlatCompat } from '@eslint/eslintrc';
import globals from 'globals';

// Scripts (CommonJS electron/, plain .mjs tooling) and the app itself get
// different globals; the compat layer is here because eslint-config-next is
// still an eslintrc-format config and this project runs ESLint 9 flat config.
const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const config = [
  { ignores: ['public/cesium/**', '.next/**', 'out/**', 'dist-desktop/**', 'node_modules/**'] },
  ...compat.extends('next/core-web-vitals'),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // react/no-unescaped-entities fires on apostrophes in prose-heavy JSX;
      // this codebase writes copy like a document, so the entity noise is not
      // worth the churn.
      'react/no-unescaped-entities': 'off',
    },
  },
];

export default config;
