# Sourced by the scripts that install npm packages into a scratch project.
#
# A scratch project takes its third-party packages from the lockfile in
# scripts/lockfiles/npm/<name>, which Dependabot keeps on the newest stable
# releases. LogBrew packages come from the build or release under test, so
# npm_add_logbrew adds them to the lockfile with the hash of that build or
# release before it installs. To add a third-party package:
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
# Adds the LogBrew packages under test to the npm project in the current
# directory. A PACKAGE is a tarball path, or NAME@VERSION from the registry that
# --registry names. Each one goes into package.json and package-lock.json with
# the sha512 of its tarball, and npm ci then installs the lockfile and refuses a
# tarball with other contents.
npm_add_logbrew() {
  local options=() packages=()
  while (($# > 0)); do
    case "$1" in
      --registry) options+=("$1" "$2"); shift 2 ;;
      -*) options+=("$1"); shift ;;
      *) packages+=("$1"); shift ;;
    esac
  done
  node - ${packages[@]+"${packages[@]}"} -- ${options[@]+"${options[@]}"} <<'JS'
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const packages = args.slice(0, args.indexOf("--"));
const options = args.slice(args.indexOf("--") + 1);
const registry = options.includes("--registry") ? ["--registry", options[options.indexOf("--registry") + 1]] : [];
const lockedFields = ["license", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bin", "engines", "os", "cpu"];

function fromTarball(file) {
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }));
  const integrity = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;
  const resolved = `file:${path.relative(process.cwd(), path.resolve(file)).split(path.sep).join("/")}`;
  return { manifest, spec: resolved, resolved, integrity };
}

function fromRegistry(spec) {
  const manifest = JSON.parse(execFileSync("npm", ["view", spec, "--json", ...registry], { encoding: "utf8" }));
  if (Array.isArray(manifest) || !manifest.dist?.integrity?.startsWith("sha512-")) {
    throw new Error(`${spec} must name 1 version with a sha512 integrity`);
  }
  return { manifest, spec: manifest.version, resolved: manifest.dist.tarball, integrity: manifest.dist.integrity };
}

const app = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = fs.existsSync("package-lock.json")
  ? JSON.parse(fs.readFileSync("package-lock.json", "utf8"))
  : { name: app.name, version: app.version, lockfileVersion: 3, requires: true, packages: { "": { name: app.name, version: app.version } } };
for (const item of packages) {
  const { manifest, spec, resolved, integrity } = fs.existsSync(item) ? fromTarball(item) : fromRegistry(item);
  app.dependencies = { ...app.dependencies, [manifest.name]: spec };
  lock.packages[""].dependencies = { ...lock.packages[""].dependencies, [manifest.name]: spec };
  const entry = { version: manifest.version, resolved, integrity };
  for (const field of lockedFields) {
    if (manifest[field] !== undefined) entry[field] = manifest[field];
  }
  lock.packages[`node_modules/${manifest.name}`] = entry;
}
fs.writeFileSync("package.json", `${JSON.stringify(app, null, 2)}\n`);
fs.writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
JS
  npm ci --no-audit --fund=false ${options[@]+"${options[@]}"}
}
