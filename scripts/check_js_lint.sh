#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
oxlint_version="1.89.0"
tsgolint_version="7.0.2005"
trap 'find "$tmp_dir" -depth -delete' EXIT

case "$(uname -s):$(uname -m)" in
  Darwin:arm64 | Darwin:aarch64)
    target="aarch64-apple-darwin" expected_sha256="fa4349f33b24221e2d303ace66de3dac2ff756eab48126b2cb58429ed36bccbc"
    tsgolint_target="darwin-arm64" tsgolint_sha256="50942d103d4eb269f7ae6db02698480b28bceba499d162bac911d6132ab63a68" ;;
  Darwin:x86_64)
    target="x86_64-apple-darwin" expected_sha256="198261cfb91c0f0387c55642ba5c2c4aa2c3cf9593188f86187c759f280bae88"
    tsgolint_target="darwin-x64" tsgolint_sha256="5ac99b907d6259a5c8bec9e205a000a027b6023bdfd2be8dd7ec6a90bd6311a0" ;;
  Linux:arm64 | Linux:aarch64)
    target="aarch64-unknown-linux-gnu" expected_sha256="69b3680c38b21395d4ea509fbd1019fa011db0cd717dd7be2ede2575cb6f7915"
    tsgolint_target="linux-arm64" tsgolint_sha256="5119c7fbbfe9775b0a8e6bad4f71eb488a3f535892e46af70de312f69bb3680a" ;;
  Linux:x86_64)
    target="x86_64-unknown-linux-gnu" expected_sha256="88492c336807a34062fa540416fe75037c04bcce1ed77824e3db3aaec215949a"
    tsgolint_target="linux-x64" tsgolint_sha256="3cd257574f2b3f0de69904ead10ca49397184e70cff481c905dd00cc4aa77554" ;;
  *)
    printf 'unsupported Oxlint platform: %s\n' "$(uname -s):$(uname -m)" >&2
    exit 1
    ;;
esac

# Downloads $1 to $2 and fails unless its SHA-256 is $3.
fetch_verified() {
  local actual_sha256
  curl -fsSL "$1" -o "$2"
  if [[ "$(uname -s)" == Darwin ]]; then
    actual_sha256="$(shasum -a 256 "$2" | awk '{print $1}')"
  else
    actual_sha256="$(sha256sum "$2" | awk '{print $1}')"
  fi
  if [[ "$actual_sha256" != "$3" ]]; then
    printf 'checksum mismatch for %s\n' "$1" >&2
    exit 1
  fi
  tar -xzf "$2" -C "$tmp_dir"
}

fetch_verified "https://github.com/oxc-project/oxc/releases/download/oxlint_v$oxlint_version/oxlint-$target.tar.gz" \
  "$tmp_dir/oxlint.tar.gz" "$expected_sha256"
# tsgolint (native Go) gives Oxlint type information. Its only distribution is the npm registry.
fetch_verified "https://registry.npmjs.org/@oxlint-tsgolint/$tsgolint_target/-/$tsgolint_target-$tsgolint_version.tgz" \
  "$tmp_dir/tsgolint.tgz" "$tsgolint_sha256"
export OXLINT_TSGOLINT_PATH="$tmp_dir/package/tsgolint"
oxlint_bin="$tmp_dir/oxlint-$target"
installed_version="$("$oxlint_bin" --version | awk '{print $2}')"
if [[ "$installed_version" != "$oxlint_version" ]]; then
  printf 'unexpected Oxlint version: %s\n' "$installed_version" >&2
  exit 1
fi

# ESLint core recommended rules plus the strict rule set. The parser rejects no-dupe-args,
# no-octal, and no-octal-escape in modules and strict code. consistent-return and
# no-invalid-this need type information, so the type-aware pass below checks them.
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

# Type-aware pass. Oxlint replaces ESLint consistent-return with typescript/consistent-return,
# and no-invalid-this with the TypeScript compiler's noImplicitThis (TS2683). TS1108 is a
# top-level return in an ES module, the one syntax error Oxlint's parser accepts. Checking
# JavaScript reports every other TypeScript diagnostic too, so only these three fail.
cat > "$tmp_dir/type-aware.json" <<'EOF'
{ "plugins": ["typescript"], "categories": { "correctness": "off" }, "rules": { "typescript/consistent-return": "error" } }
EOF
write_tsconfig() {
  cat > "$1/tsconfig.json" <<'EOF'
{
  "compilerOptions": { "allowJs": true, "checkJs": true, "noEmit": true, "noImplicitThis": true, "skipLibCheck": true, "module": "nodenext", "target": "es2024" },
  "include": ["**/*.js", "**/*.cjs", "**/*.mjs"],
  "exclude": ["**/node_modules/**"]
}
EOF
}
type_aware_findings() {
  (cd "$1" && "$oxlint_bin" --config "$tmp_dir/type-aware.json" --type-aware --type-check . || true) |
    grep -E 'typescript\((consistent-return|TS2683|TS1108)\)' || true
}

# Seeded check: the pass must catch one example of each failure class.
mkdir "$tmp_dir/seeded"
write_tsconfig "$tmp_dir/seeded"
cat > "$tmp_dir/seeded/seeded.js" <<'EOF'
export function sometimesReturns(flag) { if (flag) { return 1; } return; }
export function readsThis() { return this.value; }
EOF
printf 'return;\n' > "$tmp_dir/seeded/top-level-return.mjs"
seeded="$(type_aware_findings "$tmp_dir/seeded")"
if [[ "$seeded" != *"consistent-return"* || "$seeded" != *"TS2683"* || "$seeded" != *"TS1108"* ]]; then
  printf 'type-aware lint missed a seeded consistent-return, no-invalid-this, or top-level return example:\n%s\n' "$seeded" >&2
  exit 1
fi

cd "$repo_root"
"$oxlint_bin" --config "$tmp_dir/oxlintrc.json" --deny-warnings --report-unused-disable-directives js

if [[ -e js/tsconfig.json ]]; then
  printf '%s\n' "js/tsconfig.json exists; the type-aware lint writes its own" >&2
  exit 1
fi
write_tsconfig js
trap 'rm -f "$repo_root/js/tsconfig.json"; find "$tmp_dir" -depth -delete' EXIT
findings="$(type_aware_findings js)"
rm js/tsconfig.json
if [[ -n "$findings" ]]; then
  printf '%s\n' "$findings" >&2
  printf '%s\n' "add a JSDoc @this tag to functions that read this, and return a value on every path or none" >&2
  exit 1
fi

printf 'javascript lint ok (Oxlint %s, tsgolint %s)\n' "$installed_version" "$tsgolint_version"
