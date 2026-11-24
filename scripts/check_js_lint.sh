#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
seeded_dir="$repo_root/js/.strict-gate-seeded"
oxlint_version="1.94.0"
tsgolint_version="7.0.2007"
typescript_version="7.0.2"
written=()
trap 'rm -rf ${written[@]+"${written[@]}"}; find "$tmp_dir" -depth -delete' EXIT

case "$(uname -s):$(uname -m)" in
  Darwin:arm64 | Darwin:aarch64)
    target="aarch64-apple-darwin" expected_sha256="d31a59e3b11511075c13173f3c0b63fc0baa51477d73276dded7c308f4c26dc0"
    npm_target="darwin-arm64" tsgolint_sha256="2366d0f0d1ddc601de717b1f15afe45a8c9c849a9198821fefd6c8db030126ea"
    typescript_sha256="902e2fe1cf0799198ef902c6b8c310a450fef629a6baba41d45641ef75c04ebd" ;;
  Darwin:x86_64)
    target="x86_64-apple-darwin" expected_sha256="7fe811a85916436e786836b84f9b976b824cdc050c54f9359dbc31f16cfc5f44"
    npm_target="darwin-x64" tsgolint_sha256="1b682cd735fe901054ea2bb9f1f9ca8d771a8ac37c29f15ded1ca5f9c56bfc2b"
    typescript_sha256="eba158cb54050f723d5ff781438f33de5640054440bb4f2bd170cfe9bc2eb551" ;;
  Linux:arm64 | Linux:aarch64)
    target="aarch64-unknown-linux-gnu" expected_sha256="ae4f0f826d3a96f529e197e460c9e4ffb4450528f55f4c688f6f6936f4660159"
    npm_target="linux-arm64" tsgolint_sha256="239f7f35483dbb711beb1cf565b46664bb4764d04f29bcf3e26e60e9c48a094d"
    typescript_sha256="c83d931ac9dd7549cde6e71246aa9d6a9812843023df3e277fe3b5dcf41dd0ea" ;;
  Linux:x86_64)
    target="x86_64-unknown-linux-gnu" expected_sha256="fc1a189a35417ebda77cac83b8bfe9e9d10a7eb27e0d2fe005d222fa01261e64"
    npm_target="linux-x64" tsgolint_sha256="279fc23cc6f33ea9a6c2c088adad7bc539f243f20c81800f89ca51dfb13c4b18"
    typescript_sha256="7ecad6f67377e831856367ab062ef394f21506a611405bf8ac0ff039348637d3" ;;
  *)
    printf 'unsupported Oxlint platform: %s\n' "$(uname -s):$(uname -m)" >&2
    exit 1
    ;;
esac

fetch_verified() {
  local actual_sha256
  curl -fsSL --retry 8 "$1" -o "$2"
  if [[ "$(uname -s)" == Darwin ]]; then
    actual_sha256="$(shasum -a 256 "$2" | awk '{print $1}')"
  else
    actual_sha256="$(sha256sum "$2" | awk '{print $1}')"
  fi
  if [[ "$actual_sha256" != "$3" ]]; then
    printf 'checksum mismatch for %s\n' "$1" >&2
    exit 1
  fi
  mkdir -p "$4"
  tar -xzf "$2" -C "$4"
}

fetch_verified "https://github.com/oxc-project/oxc/releases/download/oxlint_v$oxlint_version/oxlint-$target.tar.gz" \
  "$tmp_dir/oxlint.tar.gz" "$expected_sha256" "$tmp_dir"
# The npm registry is the only distribution of tsgolint and the native TypeScript compiler.
fetch_verified "https://registry.npmjs.org/@oxlint-tsgolint/$npm_target/-/$npm_target-$tsgolint_version.tgz" \
  "$tmp_dir/tsgolint.tgz" "$tsgolint_sha256" "$tmp_dir/tsgolint"
fetch_verified "https://registry.npmjs.org/@typescript/typescript-$npm_target/-/typescript-$npm_target-$typescript_version.tgz" \
  "$tmp_dir/typescript.tgz" "$typescript_sha256" "$tmp_dir/typescript"
export OXLINT_TSGOLINT_PATH="$tmp_dir/tsgolint/package/tsgolint"
oxlint_bin="$tmp_dir/oxlint-$target"
tsc_bin="$tmp_dir/typescript/package/lib/tsc"
installed_version="$("$oxlint_bin" --version | awk '{print $2}')"
if [[ "$installed_version" != "$oxlint_version" ]]; then
  printf 'unexpected Oxlint version: %s\n' "$installed_version" >&2
  exit 1
fi
if [[ "$("$tsc_bin" --version)" != "Version $typescript_version" ]]; then
  printf 'unexpected TypeScript version: %s\n' "$("$tsc_bin" --version)" >&2
  exit 1
fi

# The parser rejects no-dupe-args, no-octal, and no-octal-escape in modules and strict code.
cat > "$tmp_dir/oxlintrc.json" <<'EOF'
{
  "plugins": [],
  "categories": { "correctness": "error" },
  "env": { "builtin": true, "es2026": true, "node": true },
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
    "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "ignoreRestSiblings": true, "varsIgnorePattern": "^_" }],
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

# Oxlint has no no-invalid-this; TS2683 (noImplicitThis) stands in. TS1108 is the one syntax error
# Oxlint's parser accepts. Checking JavaScript reports every other diagnostic too, so only these fail.
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
  (cd "$1" && "$oxlint_bin" --config "$tmp_dir/type-aware.json" --ignore-pattern '**/node_modules/**' --type-aware --type-check . || true) |
    grep -E 'typescript\((consistent-return|TS2683|TS1108)\)' || true
}

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
"$oxlint_bin" --config "$tmp_dir/oxlintrc.json" --ignore-pattern '**/node_modules/**' --deny-warnings --report-unused-disable-directives js

if [[ -e js/tsconfig.json ]]; then
  printf '%s\n' "js/tsconfig.json exists; the type-aware lint writes its own" >&2
  exit 1
fi
written+=("$repo_root/js/tsconfig.json")
write_tsconfig js
findings="$(type_aware_findings js)"
rm js/tsconfig.json
if [[ -n "$findings" ]]; then
  printf '%s\n' "$findings" >&2
  printf '%s\n' "add a JSDoc @this tag to functions that read this, and return a value on every path or none" >&2
  exit 1
fi

script_files() {
  git ls-files --cached --others --exclude-standard -- "${@:-.}" |
    { grep -E '\.(js|cjs|mjs|jsx|ts|cts|mts|tsx)$' || true; } | sort
}

joined=()
while IFS= read -r config; do
  if grep -qE '"extends": "[./]*(js/)?tsconfig\.base\.json"' "$config"; then
    joined+=("$(dirname "$config")")
  fi
done < <(git ls-files --cached --others --exclude-standard -- '*tsconfig.json')
pending=()
while IFS= read -r entry; do
  pending+=("$entry")
done < <(sed -n 's/^pending = //p' quality/tool-matrix.toml | { grep -oE '"[^"]+"' || true; } | tr -d '"')

covered_by() {
  local unit
  for unit in "$@"; do
    if [[ "$file" == "$unit" || "$file" == "$unit/"* ]]; then
      return 0
    fi
  done
  return 1
}

coverage=""
for entry in ${pending[@]+"${pending[@]}"}; do
  if [[ -z "$(script_files "$entry")" ]]; then
    coverage+="$entry: pending, but it holds no JavaScript or TypeScript; remove it from \`pending\`"$'\n'
  fi
  for unit in ${joined[@]+"${joined[@]}"}; do
    if [[ "$entry" == "$unit" || "$entry" == "$unit/"* || "$unit" == "$entry/"* ]]; then
      coverage+="$entry: pending, but $unit/tsconfig.json joined the strict gate; remove it from \`pending\`"$'\n'
    fi
  done
done
while IFS= read -r file; do
  if ! covered_by ${joined[@]+"${joined[@]}"} && ! covered_by ${pending[@]+"${pending[@]}"}; then
    coverage+="$file: outside every strict project; add a tsconfig.json that extends js/tsconfig.base.json"$'\n'
  fi
done < <(script_files)
if [[ -n "$coverage" ]]; then
  printf '%s' "$coverage" >&2
  exit 1
fi

(cd js && bun install --frozen-lockfile --ignore-scripts --silent)
for unit in ${joined[@]+"${joined[@]}"}; do
  if [[ -f "$unit/bun.lock" ]]; then
    (cd "$unit" && bun install --frozen-lockfile --ignore-scripts --silent)
  fi
  if [[ -f "$unit/prisma/schema.prisma" ]]; then
    if ! generated="$(CHECKPOINT_DISABLE=1 bun --bun js/node_modules/.bin/prisma generate --schema "$unit/prisma/schema.prisma" 2>&1)"; then
      printf '%s\n' "$generated" >&2
      exit 1
    fi
  fi
done

source_files() {
  script_files "$@"
}

type_check() {
  local listed file status=0
  "$tsc_bin" --project "$1" --pretty false || status=1
  listed="$("$tsc_bin" --project "$1" --listFilesOnly)"
  while IFS= read -r file; do
    if ! grep -qxF "$repo_root/$file" <<<"$listed"; then
      printf '%s: not in the TypeScript program; include it in %s/tsconfig.json or import its types\n' "$file" "$1"
      status=1
    fi
  done < <(source_files "$1")
  return "$status"
}

# Neither tool reports suppression comments, a JSDoc any, or prose comments.
comment_findings() {
  local file
  for file in "$@"; do
    grep -nE 'eslint-[d]isable|oxlint-[d]isable|@ts-(ignore|expect-error|nocheck)' "$file" |
      sed "s|^|$file:|; s|$| (suppression comment)|" || true
    case "$file" in *.d.ts | *.d.cts) continue ;; esac
    awk -v file="$file" '
      function report(message) { printf "%s:%d: %s\n", file, FNR, message }
      FNR == 1 && /^#!/ { next }
      inside {
        line = $0
        sub(/^[ \t]*\*\/.*$/, "", line)
        closing = ($0 ~ /\*\//)
        sub(/\*\/.*$/, "", line)
        sub(/^[ \t]*\*?/, "", line)
        if (line ~ /(^|[^A-Za-z_])any([^A-Za-z_]|$)|\{[*?]\}/) report("JSDoc any type")
        if (line != "" && line !~ /^ ?@/ && line !~ /^ ?[})|]/ && line !~ /^   /) report("comment text; JSDoc here holds type tags only")
        if (closing) inside = 0
        next
      }
      /^[ \t]*\/\/|^[ \t]*\/\*([^*]|$)/ { report("comment; only JSDoc type tags are allowed"); next }
      /\/\*\*/ {
        line = $0
        sub(/^.*\/\*\*/, "", line)
        if (line ~ /\*\//) {
          sub(/\*\/.*$/, "", line)
          if (line ~ /(^|[^A-Za-z_])any([^A-Za-z_]|$)|\{[*?]\}/) report("JSDoc any type")
          if (line !~ /^ *(@|$)/) report("comment text; JSDoc here holds type tags only")
        } else {
          if (line ~ /(^|[^A-Za-z_])any([^A-Za-z_]|$)|\{[*?]\}/) report("JSDoc any type")
          if (line !~ /^ *(@|$)/) report("comment text; JSDoc here holds type tags only")
          inside = 1
        }
      }
    ' "$file"
  done
}

strict_lint() {
  "$oxlint_bin" --config js/.oxlintrc.json --type-aware --deny-warnings --report-unused-disable-directives "$@"
}

if [[ -e "$seeded_dir" ]]; then
  printf '%s exists; the strict gate writes its own seeded example there\n' "$seeded_dir" >&2
  exit 1
fi
written+=("$seeded_dir")
mkdir "$seeded_dir"
printf '{ "type": "module" }\n' > "$seeded_dir/package.json"
printf '{ "extends": "../tsconfig.base.json", "include": ["*.js"] }\n' > "$seeded_dir/tsconfig.json"
cat > "$seeded_dir/seeded.js" <<'EOF'
/**
 * @param {unknown} value
 * @returns {string}
 */
function narrows(value) {
  const text =
    /** @type {string} */ (value);
  return text;
}

function implicitAny(value) {
  return value;
}

/**
 * Returns the value unchanged.
 * @param {any} value
 * @returns {unknown}
 */
function explicitAny(value) {
  return value;
}

EOF
# Build the seeded suppression comment at run time so this script holds none itself.
printf '// @ts-%s\nexport { explicitAny, implicitAny, narrows };\n' ignore >> "$seeded_dir/seeded.js"
seeded="$(type_check "$seeded_dir" 2>&1 || true; strict_lint "$seeded_dir" 2>&1 || true; comment_findings "$seeded_dir/seeded.js")"
for marker in "TS7006" "no-unsafe-type-assertion" "JSDoc any type" "suppression comment" "comment text"; do
  if [[ "$seeded" != *"$marker"* ]]; then
    printf 'strict JavaScript gate missed the seeded %s example:\n%s\n' "$marker" "$seeded" >&2
    exit 1
  fi
done
rm -r "$seeded_dir"

if ((${#joined[@]} > 0)); then
  status=0
  for package_dir in "${joined[@]}"; do
    type_check "$package_dir" || status=1
  done
  strict_lint "${joined[@]}" || status=1
  files=()
  while IFS= read -r file; do
    files+=("$file")
  done < <(source_files "${joined[@]}")
  comments="$(comment_findings "${files[@]}")"
  if [[ -n "$comments" ]]; then
    printf '%s\n' "$comments"
    status=1
  fi
  if ((status != 0)); then
    printf 'strict JavaScript gate failed for: %s\n' "${joined[*]}" >&2
    exit 1
  fi
fi

printf 'javascript lint ok (Oxlint %s, tsgolint %s, TypeScript %s; strict: %s)\n' \
  "$installed_version" "$tsgolint_version" "$typescript_version" "${joined[*]:-none}"
