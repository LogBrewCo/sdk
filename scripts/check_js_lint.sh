#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

cd "$tmp_dir"
npm init -y >/dev/null
npm install \
  --save-exact \
  --no-package-lock \
  --ignore-scripts \
  --no-audit \
  --fund=false \
  eslint@10.4.1 \
  @eslint/js@10.0.1 \
  >/dev/null

cat > eslint.config.mjs <<'EOF'
import js from "@eslint/js";

const nodeGlobals = {
  console: "readonly",
  fetch: "readonly",
  performance: "readonly",
  process: "readonly",
  Request: "readonly",
  Response: "readonly",
  setTimeout: "readonly",
  URL: "readonly"
};

const commonJsGlobals = {
  require: "readonly",
  module: "readonly",
  exports: "readonly"
};

const strictRules = {
  ...js.configs.recommended.rules,
  "array-callback-return": "error",
  "block-scoped-var": "error",
  "consistent-return": "error",
  curly: ["error", "all"],
  eqeqeq: ["error", "always"],
  "no-alert": "error",
  "no-caller": "error",
  "no-console": "off",
  "no-constructor-return": "error",
  "no-else-return": "error",
  "no-eval": "error",
  "no-extend-native": "error",
  "no-implicit-coercion": "error",
  "no-implied-eval": "error",
  "no-invalid-this": "error",
  "no-iterator": "error",
  "no-labels": "error",
  "no-lone-blocks": "error",
  "no-loop-func": "error",
  "no-new": "error",
  "no-new-func": "error",
  "no-new-wrappers": "error",
  "no-object-constructor": "error",
  "no-param-reassign": "error",
  "no-promise-executor-return": "error",
  "no-proto": "error",
  "no-return-assign": ["error", "always"],
  "no-script-url": "error",
  "no-self-compare": "error",
  "no-sequences": "error",
  "no-template-curly-in-string": "error",
  "no-unmodified-loop-condition": "error",
  "no-unneeded-ternary": "error",
  "no-unreachable-loop": "error",
  "no-unused-expressions": "error",
  "no-useless-call": "error",
  "no-useless-computed-key": "error",
  "no-useless-concat": "error",
  "no-useless-constructor": "error",
  "no-useless-rename": "error",
  "no-var": "error",
  "object-shorthand": ["error", "always"],
  "one-var": ["error", "never"],
  "prefer-arrow-callback": "error",
  "prefer-const": "error",
  "prefer-object-spread": "error",
  "prefer-template": "error",
  radix: "error",
  yoda: "error"
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/vendor/**",
      "**/target/**",
      "**/dist/**",
      "**/build/**"
    ]
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals
    },
    rules: strictRules
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...nodeGlobals,
        ...commonJsGlobals
      }
    }
  }
];
EOF

cd "$repo_root"
"$tmp_dir/node_modules/.bin/eslint" \
  --config "$tmp_dir/eslint.config.mjs" \
  --max-warnings=0 \
  js

printf '%s\n' "javascript eslint ok"
