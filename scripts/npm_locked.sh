# Sourced by the scripts that install npm packages into a scratch project.
#
# A scratch project takes its third-party packages from the lockfile in
# scripts/lockfiles/npm/<name>, which Dependabot keeps on the newest stable
# releases. LogBrew packages come from the build or release under test, so they
# install separately and never from a lockfile. To add a third-party package:
#   (cd scripts/lockfiles/npm/<name> && npm install --package-lock-only --save-exact PACKAGE@VERSION)

lockfiles_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lockfiles/npm"

# npm_ci_locked NAME [NPM_OPTION...]
# Installs the packages NAME locks into the npm project in the current directory.
npm_ci_locked() {
  local deps="$lockfiles_root/$1"
  shift
  node - "$deps/package.json" package.json <<'JS'
const fs = require("node:fs");
const [locked, target] = process.argv.slice(2);
const app = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {};
const manifest = JSON.parse(fs.readFileSync(locked, "utf8"));
app.dependencies = manifest.dependencies;
app.devDependencies = manifest.devDependencies;
app.overrides = manifest.overrides;
fs.writeFileSync(target, `${JSON.stringify(app, null, 2)}\n`);
JS
  cp "$deps/package-lock.json" package-lock.json
  if [[ -f "$deps/.npmrc" ]]; then
    cp "$deps/.npmrc" .npmrc
  fi
  npm ci --no-audit --fund=false "$@"
}

# npm_locked_versions NAME PACKAGE...
# Prints the version NAME locks for each PACKAGE, separated by spaces.
npm_locked_versions() {
  node - "$lockfiles_root/$1/package.json" "${@:2}" <<'JS'
const fs = require("node:fs");
const [manifest, ...names] = process.argv.slice(2);
const locked = JSON.parse(fs.readFileSync(manifest, "utf8"));
const dependencies = { ...locked.dependencies, ...locked.devDependencies };
const missing = names.filter((name) => !dependencies[name]);
if (missing.length > 0) {
  console.error(`${manifest} locks no ${missing.join(", ")}`);
  process.exit(1);
}
console.log(names.map((name) => dependencies[name]).join(" "));
JS
}

# npm_add_logbrew [NPM_OPTION...] PACKAGE...
# Adds the LogBrew packages under test the way a user does. They stay unpinned
# on purpose: the smoke must install the build or release it tests.
npm_add_logbrew() {
  npm install --save-exact --no-audit --fund=false "$@"
}
