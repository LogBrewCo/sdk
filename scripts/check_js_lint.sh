#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
oxlint_version="1.88.0"
trap 'find "$tmp_dir" -depth -delete' EXIT

case "$(uname -s):$(uname -m)" in
  Darwin:arm64 | Darwin:aarch64) target="aarch64-apple-darwin"; expected_sha256="2d42070507d549f064f1fe11220970ddea868eff99da4c0696be728236bc0200" ;;
  Darwin:x86_64) target="x86_64-apple-darwin"; expected_sha256="9a591fb3e4837052a4137f8e22738d9cb888f8ab2ddd80c683b7bd68e9b674b2" ;;
  Linux:arm64 | Linux:aarch64) target="aarch64-unknown-linux-gnu"; expected_sha256="d15f1941e903795b30f9a02bec2c015ef903eef271f43f408c021599bca7301c" ;;
  Linux:x86_64) target="x86_64-unknown-linux-gnu"; expected_sha256="ce05865b75d9a51a03052c256068e63501ba2d4e6327376b2affbe14bf975b3c" ;;
  *)
    printf 'unsupported Oxlint platform: %s\n' "$(uname -s):$(uname -m)" >&2
    exit 1
    ;;
esac

archive_path="$tmp_dir/oxlint-$target.tar.gz"
curl -fsSL "https://github.com/oxc-project/oxc/releases/download/oxlint_v$oxlint_version/oxlint-$target.tar.gz" -o "$archive_path"
if [[ "$(uname -s)" == Darwin ]]; then
  actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
else
  actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
fi
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  printf 'Oxlint archive checksum mismatch for %s\n' "$target" >&2
  exit 1
fi
tar -xzf "$archive_path" -C "$tmp_dir"
oxlint_bin="$tmp_dir/oxlint-$target"
installed_version="$("$oxlint_bin" --version | awk '{print $2}')"
if [[ "$installed_version" != "$oxlint_version" ]]; then
  printf 'unexpected Oxlint version: %s\n' "$installed_version" >&2
  exit 1
fi

# ESLint core recommended rules plus the strict rule set. Oxlint has no equivalent for
# consistent-return, no-invalid-this, no-dupe-args, no-octal, or no-octal-escape; the
# parser rejects the last three in modules and strict code.
cat > "$tmp_dir/oxlintrc.json" <<'EOF'
{
  "plugins": [],
  "categories": { "correctness": "error" },
  "env": { "builtin": true, "es2026": true, "node": true },
  "ignorePatterns": ["**/node_modules/**", "**/vendor/**", "**/target/**", "**/dist/**", "**/build/**"],
  "rules": {
    "no-case-declarations": "error",
    "no-empty": "error",
    "no-fallthrough": "error",
    "no-prototype-builtins": "error",
    "no-redeclare": ["error", { "builtinGlobals": false }],
    "no-regex-spaces": "error",
    "no-undef": "error",
    "no-unexpected-multiline": "error",
    "no-useless-assignment": "error",
    "preserve-caught-error": "error",
    "array-callback-return": "error",
    "block-scoped-var": "error",
    "curly": ["error", "all"],
    "eqeqeq": ["error", "always"],
    "no-alert": "error",
    "no-caller": "error",
    "no-constructor-return": "error",
    "no-else-return": "error",
    "no-eval": "error",
    "no-extend-native": "error",
    "no-implicit-coercion": "error",
    "no-implied-eval": "error",
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
    "radix": "error",
    "yoda": "error"
  },
  "overrides": [
    { "files": ["**/*.cjs"], "env": { "commonjs": true } },
    { "files": ["**/logbrew-browser/**"], "env": { "browser": true } },
    { "files": ["**/logbrew-node/test/run.mjs"], "globals": { "Bun": "readonly" } }
  ]
}
EOF

cd "$repo_root"
"$oxlint_bin" --config "$tmp_dir/oxlintrc.json" --deny-warnings --report-unused-disable-directives js

printf 'javascript lint ok (Oxlint %s)\n' "$installed_version"
