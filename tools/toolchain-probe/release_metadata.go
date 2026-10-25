package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"encoding/xml"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/pelletier/go-toml/v2"
)

const (
	releaseMetadataMode     = "release-metadata"
	publicLicense           = "MIT"
	sdkRepoURL              = "https://github.com/LogBrewCo/sdk"
	npmRepoURL              = "git+https://github.com/LogBrewCo/sdk.git"
	openUPMUnityMetadata    = ".github/publishing/openupm-co.logbrew.unity.yml"
	publishReleaseWorkflow  = ".github/workflows/publish-release.yml"
	publishPackagesWorkflow = ".github/workflows/publish-packages.yml"
	publishNuGetWorkflow    = ".github/workflows/publish-nuget.yml"
	reconcilePublicWorkflow = ".github/workflows/reconcile-public-packages.yml"
	checkoutDiscardsAuth    = "persist-credentials: false"
	protectedRegistryCheck  = `"$RUNNER_TEMP/logbrew-release-control-probe" registry-publication`
	mavenSelectorInput      = "${{ inputs.maven_artifacts }}"
	nugetSelectorInput      = "${{ inputs.nuget_packages }}"
)

//go:embed release-catalog.toml
var releaseCatalogText string

var publicSemver = regexp.MustCompile(`^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$`)

// releaseCatalog holds the public package identities and versions that
// release-catalog.toml declares.
type releaseCatalog struct {
	PublicVersion  string         `toml:"public_version"`
	Rust           string         `toml:"rust"`
	RubyGems       string         `toml:"rubygems"`
	Packagist      string         `toml:"packagist"`
	Unity          string         `toml:"unity"`
	Maven          string         `toml:"maven"`
	JavaMaven      string         `toml:"java_maven"`
	NPM            [][]string     `toml:"npm"`
	MavenArtifacts [][]string     `toml:"maven_artifacts"`
	RepoWide       [][]string     `toml:"repo_wide"`
	NuGet          []nugetRelease `toml:"nuget"`
	PyPI           []pypiRelease  `toml:"pypi"`
}

type nugetRelease struct {
	ID            string `toml:"id"`
	Version       string `toml:"version"`
	VersionOutput string `toml:"version_output"`
}

func (release nugetRelease) project() string {
	return "dotnet/logbrew-dotnet/src/" + release.ID + "/" + release.ID + ".csproj"
}

type pypiRelease struct {
	OptionalDependencies map[string][]string `toml:"optional_dependencies"`
	Dir                  string              `toml:"dir"`
	Name                 string              `toml:"name"`
	Version              string              `toml:"version"`
	Package              string              `toml:"package"`
	Description          string              `toml:"description"`
	RequiresPython       string              `toml:"requires_python"`
	Dependencies         []string            `toml:"dependencies"`
}

func loadReleaseCatalog(text string) (releaseCatalog, error) {
	var catalog releaseCatalog
	decoder := toml.NewDecoder(strings.NewReader(text))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&catalog); err != nil {
		return catalog, err
	}
	for _, entry := range catalog.NPM {
		if len(entry) != 2 {
			return catalog, errors.New("each npm entry needs a directory and a package name")
		}
	}
	for _, entry := range catalog.MavenArtifacts {
		if len(entry) < 2 {
			return catalog, errors.New("each maven_artifacts entry needs an artifact and a directory")
		}
	}
	for _, entry := range catalog.RepoWide {
		if len(entry) != 3 {
			return catalog, errors.New("each repo_wide entry needs an ecosystem, a package, and a manifest")
		}
	}
	return catalog, nil
}

type versionFlags []string

func (values *versionFlags) String() string { return strings.Join(*values, ",") }

func (values *versionFlags) Set(value string) error {
	*values = append(*values, value)
	return nil
}

// checkReleaseMetadata fails when publish-facing package metadata, release
// workflows, or release documentation drift from the release catalog.
func checkReleaseMetadata(arguments []string, output, diagnostic io.Writer) int {
	catalog, err := loadReleaseCatalog(releaseCatalogText)
	if err != nil {
		return writeText(diagnostic, "release catalog is invalid: "+err.Error()+"\n", exitFailure)
	}
	flags := flag.NewFlagSet(releaseMetadataMode, flag.ContinueOnError)
	flags.SetOutput(diagnostic)
	onlyCpp := flags.Bool("only-cpp", false, "check only the C++ package")
	var npmFlags, nugetFlags versionFlags
	flags.Var(&npmFlags, "npm-version", "expected PACKAGE=VERSION for one npm package")
	flags.Var(&nugetFlags, "nuget-version", "expected PACKAGE=VERSION for one NuGet package")
	usage := "usage: release-metadata [--only-cpp] [--npm-version PACKAGE=VERSION]... " +
		"[--nuget-version PACKAGE=VERSION]... [root]\n"
	if flags.Parse(arguments) != nil || flags.NArg() > 1 {
		return writeText(diagnostic, usage, exitUsage)
	}
	npmVersions, err := parsePackageVersions(npmFlags, catalog.npmNames())
	if err == nil {
		var nugetVersions map[string]string
		nugetVersions, err = parsePackageVersions(nugetFlags, catalog.nugetIDs())
		root, rootError := filepath.Abs(cmpOr(flags.Arg(0), "."))
		if err == nil && rootError == nil {
			check := &metadataCheck{root: root, catalog: catalog}
			if *onlyCpp {
				check.cpp()
			} else {
				check.all(npmVersions, nugetVersions)
			}
			if len(check.failures) > 0 {
				return writeText(diagnostic, strings.Join(check.failures, "\n")+"\n", exitFailure)
			}
			return writeText(output, "release metadata ok\n", exitOK)
		}
		err = errors.Join(err, rootError)
	}
	return writeText(diagnostic, usage+"release-metadata: "+err.Error()+"\n", exitUsage)
}

func cmpOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func (catalog releaseCatalog) npmNames() []string {
	names := make([]string, 0, len(catalog.NPM))
	for _, entry := range catalog.NPM {
		names = append(names, entry[1])
	}
	return names
}

func (catalog releaseCatalog) nugetIDs() []string {
	ids := make([]string, 0, len(catalog.NuGet))
	for _, release := range catalog.NuGet {
		ids = append(ids, release.ID)
	}
	return ids
}

func parsePackageVersions(raw []string, allowed []string) (map[string]string, error) {
	versions := map[string]string{}
	for _, value := range raw {
		name, version, found := strings.Cut(value, "=")
		name, version = strings.TrimSpace(name), strings.TrimSpace(version)
		if !found || name == "" || version == "" {
			return nil, fmt.Errorf("expected package version in name=version form, got %s", pyRepr(value))
		}
		if !slices.Contains(allowed, name) {
			return nil, errors.New("unknown package: " + name)
		}
		versions[name] = version
	}
	return versions, nil
}

type metadataCheck struct {
	root     string
	failures []string
	catalog  releaseCatalog
}

func (check *metadataCheck) require(ok bool, message string) {
	if !ok {
		check.failures = append(check.failures, message)
	}
}

func (check *metadataCheck) exists(relative string) bool {
	_, err := os.Stat(filepath.Join(check.root, relative))
	return err == nil
}

func (check *metadataCheck) requirePaths(relatives ...string) bool {
	found := true
	for _, relative := range relatives {
		exists := check.exists(relative)
		check.require(exists, "missing required path: "+relative)
		found = found && exists
	}
	return found
}

func (check *metadataCheck) read(relative string) string {
	data, err := os.ReadFile(filepath.Join(check.root, relative))
	if err != nil {
		return ""
	}
	return string(data)
}

func (check *metadataCheck) equal(location, field string, actual, expected any) {
	check.require(reflect.DeepEqual(actual, expected),
		fmt.Sprintf("%s: expected %s %s, got %s", location, field, pyRepr(expected), pyRepr(actual)))
}

func (check *metadataCheck) contains(location, field string, actual any, needle string) {
	text, ok := actual.(string)
	check.require(ok && strings.Contains(text, needle),
		fmt.Sprintf("%s: expected %s to include %s, got %s", location, field, pyRepr(needle), pyRepr(actual)))
}

func (check *metadataCheck) needles(text, prefix string, needles ...string) {
	for _, needle := range needles {
		check.require(strings.Contains(text, needle), prefix+needle)
	}
}

// described requires each {description, needle} pair in text.
func (check *metadataCheck) described(text, location string, pairs [][2]string) {
	for _, pair := range pairs {
		check.require(strings.Contains(text, pair[1]), location+": missing "+pair[0])
	}
}

func (check *metadataCheck) readJSON(relative string) map[string]any {
	path := filepath.Join(check.root, relative)
	data, err := os.ReadFile(path)
	var payload any
	if err == nil {
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.UseNumber()
		if err = decoder.Decode(&payload); err == nil {
			if _, trailing := decoder.Token(); !errors.Is(trailing, io.EOF) {
				err = errors.New("extra data after the JSON value")
			}
		}
	}
	if err != nil {
		check.failures = append(check.failures, path+": invalid JSON: "+err.Error())
		return map[string]any{}
	}
	object, ok := payload.(map[string]any)
	check.require(ok, path+": expected a JSON object")
	return object
}

func (check *metadataCheck) readTOML(relative string) map[string]any {
	path := filepath.Join(check.root, relative)
	data, err := os.ReadFile(path)
	payload := map[string]any{}
	if err == nil {
		err = toml.Unmarshal(data, &payload)
	}
	if err != nil {
		check.failures = append(check.failures, path+": invalid TOML: "+err.Error())
		return map[string]any{}
	}
	return payload
}

// field reads nested object members and returns nil when any level is not an object.
func field(value any, keys ...string) any {
	for _, key := range keys {
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = object[key]
	}
	return value
}

func listHas(value any, wanted any) bool {
	items, ok := value.([]any)
	return ok && slices.ContainsFunc(items, func(item any) bool { return reflect.DeepEqual(item, wanted) })
}

// pySet is a sorted set of strings that prints like a Python set.
type pySet []string

func newPySet(values ...string) pySet {
	set := slices.Clone(values)
	slices.Sort(set)
	return slices.Compact(set)
}

func stringSet(value any) pySet {
	items, _ := value.([]any)
	values := []string{}
	for _, item := range items {
		if text, ok := item.(string); ok {
			values = append(values, text)
		}
	}
	return newPySet(values...)
}

// pyRepr prints a value the way Python's repr does, so findings keep the
// wording of the Python check this mode replaced.
func pyRepr(value any) string {
	switch typed := value.(type) {
	case nil:
		return "None"
	case bool:
		return map[bool]string{true: "True", false: "False"}[typed]
	case string:
		return pyString(typed)
	case pySet:
		if len(typed) == 0 {
			return "set()"
		}
		return "{" + joinRepr(typed) + "}"
	case []string:
		return "[" + joinRepr(typed) + "]"
	case []any:
		return "[" + joinRepr(typed) + "]"
	case map[string]any:
		return mapRepr(typed)
	case map[string]pySet:
		return mapRepr(typed)
	}
	return fmt.Sprint(value)
}

func joinRepr[T any](values []T) string {
	parts := make([]string, len(values))
	for index, value := range values {
		parts[index] = pyRepr(value)
	}
	return strings.Join(parts, ", ")
}

func mapRepr[T any](values map[string]T) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	parts := make([]string, len(keys))
	for index, key := range keys {
		parts[index] = pyString(key) + ": " + pyRepr(values[key])
	}
	return "{" + strings.Join(parts, ", ") + "}"
}

func pyString(text string) string {
	quote := '\''
	if strings.ContainsRune(text, '\'') && !strings.ContainsRune(text, '"') {
		quote = '"'
	}
	var builder strings.Builder
	builder.WriteRune(quote)
	for _, character := range text {
		switch {
		case character == '\\' || character == quote:
			builder.WriteRune('\\')
			builder.WriteRune(character)
		case character == '\n':
			builder.WriteString(`\n`)
		case character == '\r':
			builder.WriteString(`\r`)
		case character == '\t':
			builder.WriteString(`\t`)
		case character < 0x100 && !unicode.IsPrint(character):
			fmt.Fprintf(&builder, `\x%02x`, character)
		case character < 0x10000 && !unicode.IsPrint(character):
			fmt.Fprintf(&builder, `\u%04x`, character)
		case !unicode.IsPrint(character):
			fmt.Fprintf(&builder, `\U%08x`, character)
		default:
			builder.WriteRune(character)
		}
	}
	builder.WriteRune(quote)
	return builder.String()
}

func (check *metadataCheck) all(npmVersions, nugetVersions map[string]string) {
	check.repositoryRoot()
	check.releaseWorkflows()
	check.jsPackages(npmVersions)
	check.rust()
	check.python()
	check.goModules()
	check.c()
	check.cpp()
	check.objc()
	check.mavenPOM("java/logbrew-java/pom.xml", "logbrew-sdk", "LogBrew Java SDK", true, check.catalog.JavaMaven)
	check.dotnet(nugetVersions)
	check.unity()
	check.mavenPOM("kotlin/logbrew-kotlin/pom.xml", "logbrew-kotlin", "LogBrew Kotlin SDK", false, check.catalog.Maven)
	check.mavenPOM("kotlin/logbrew-kotlin-okhttp/pom.xml", "logbrew-kotlin-okhttp",
		"LogBrew Kotlin OkHttp Integration", false, check.catalog.Maven)
	check.ruby()
	check.php()
	check.swift()
}

func (check *metadataCheck) repositoryRoot() {
	check.requirePaths("README.md", "LICENSE")
	check.require(strings.Contains(check.read("LICENSE"), "MIT License"), "LICENSE: expected MIT License text")
}

func (check *metadataCheck) jsPackages(versions map[string]string) {
	matches, _ := filepath.Glob(filepath.Join(check.root, "js", "logbrew-*", "package.json"))
	actual, expected := []string{}, []string{}
	for _, match := range matches {
		relative, _ := filepath.Rel(check.root, filepath.Dir(match))
		actual = append(actual, filepath.ToSlash(relative))
	}
	for _, entry := range check.catalog.NPM {
		expected = append(expected, entry[0])
	}
	check.equal("js", "public package directories", newPySet(actual...), newPySet(expected...))
	for _, entry := range check.catalog.NPM {
		check.jsPackage(entry[0], entry[1], versions[entry[1]])
	}
}

func (check *metadataCheck) jsPackage(directory, name, expectedVersion string) {
	location := directory + "/package.json"
	check.requirePaths(directory)
	if !check.requirePaths(location) {
		return
	}
	manifest := check.readJSON(location)
	check.requirePaths(directory + "/README.md")
	check.equal(location, "name", manifest["name"], name)
	if expectedVersion == "" {
		version, ok := manifest["version"].(string)
		check.require(ok && publicSemver.MatchString(version),
			location+": expected version to be a public semver, got "+pyRepr(manifest["version"]))
	} else {
		check.equal(location, "version", manifest["version"], expectedVersion)
	}
	check.equal(location, "license", manifest["license"], publicLicense)
	check.require(manifest["private"] != true, location+": public SDK package must not be private")
	check.contains(location, "description", manifest["description"], "LogBrew")
	for _, pair := range [][3]any{
		{"repository.type", field(manifest, "repository", "type"), "git"},
		{"repository.url", field(manifest, "repository", "url"), npmRepoURL},
		{"engines.node", field(manifest, "engines", "node"), ">=18"},
		{"sideEffects", manifest["sideEffects"], false},
		{"type", manifest["type"], "module"},
		{"main", manifest["main"], "./index.cjs"},
	} {
		check.equal(location, pair[0].(string), pair[1], pair[2])
	}
	if manifest["module"] != nil {
		check.equal(location, "module", manifest["module"], "./index.js")
	}
	check.equal(location, "types", manifest["types"], "./index.d.ts")
	files := stringSet(manifest["files"])
	required := []string{"README.md", "examples", "index.js", "index.cjs", "index.d.ts", "index.d.cts"}
	exports := []string{}
	switch name {
	case "@logbrew/sdk":
		required = append(required, "release-artifacts-common.js", "release-artifacts.js",
			"release-artifacts-upload.js", "release-artifacts-symbolication.js", "vite-release-artifacts.cjs",
			"vite-release-artifacts.js", "vite-release-artifacts.d.ts", "vite-release-artifacts.d.cts")
		exports = []string{"vite-release-artifacts"}
	case "@logbrew/next":
		required = append(required, "instrumentation.cjs", "instrumentation.js", "instrumentation.d.ts",
			"instrumentation.d.cts", "release-artifacts.cjs", "release-artifacts.js", "release-artifacts.d.ts",
			"release-artifacts.d.cts")
		exports = []string{"instrumentation", "release-artifacts"}
	case "@logbrew/react-native":
		required = append(required, "index.native.js", "apple-native-diagnostics.js",
			"apple-native-diagnostics.d.ts", "expo.cjs", "expo.js", "expo.d.ts", "ios/AppleDiagnostics",
			"ios/GeneratedAppleDiagnostics", "scripts/sync-apple-native-sources.mjs", "release-artifacts.cjs",
			"release-artifacts.js", "release-artifacts.d.ts", "release-artifacts.d.cts")
		exports = []string{"release-artifacts"}
	}
	for _, file := range required {
		check.require(slices.Contains(files, file), location+": files must include "+pyRepr(file))
	}
	if name == "@logbrew/sdk" {
		check.equal(location, "bin.logbrew-release-artifacts", field(manifest, "bin", "logbrew-release-artifacts"),
			"./release-artifacts.js")
	}
	for _, export := range exports {
		check.jsExport(location, manifest, "./"+export, export, ".d.cts")
	}
	if name == "@logbrew/react-native" {
		const diagnostics = "./apple-native-diagnostics"
		for _, member := range []string{"types", "default"} {
			check.equal(location, "exports['"+diagnostics+"'].react-native."+member,
				field(manifest, "exports", diagnostics, "react-native", member),
				diagnostics+map[string]string{"types": ".d.ts", "default": ".js"}[member])
		}
		check.jsExport(location, manifest, "./expo", "expo", ".d.ts")
		check.equal(location, "peerDependencies.expo", field(manifest, "peerDependencies", "expo"), ">=49")
		check.equal(location, "peerDependenciesMeta.expo.optional",
			field(manifest, "peerDependenciesMeta", "expo", "optional"), true)
	}
	if name == "@logbrew/amqplib" {
		check.equal(location, "peerDependencies.amqplib", field(manifest, "peerDependencies", "amqplib"), ">=0.10")
	}
	if name == "@logbrew/node" {
		peer, _ := field(manifest, "peerDependencies", "@logbrew/sdk").(string)
		core, _ := check.readJSON("js/logbrew-js/package.json")["version"].(string)
		check.require(caretAllows(peer, core), location+": peerDependencies.@logbrew/sdk must allow @logbrew/sdk "+core)
	}
	check.jsExport(location, manifest, ".", "index", ".d.cts")
}

// jsExport requires the import and require conditions of one export to point
// at ./<base>.d.ts, ./<base>.js, ./<base><requireTypes>, and ./<base>.cjs.
func (check *metadataCheck) jsExport(location string, manifest map[string]any, name, base, requireTypes string) {
	entry, ok := field(manifest, "exports", name).(map[string]any)
	label := "exports[" + pyRepr(name) + "]"
	check.require(ok, location+": "+label+" must be an object")
	if !ok {
		return
	}
	for _, condition := range [][3]string{
		{"import", "types", ".d.ts"}, {"import", "default", ".js"},
		{"require", "types", requireTypes}, {"require", "default", ".cjs"},
	} {
		check.equal(location, label+"."+condition[0]+"."+condition[1], field(entry, condition[0], condition[1]),
			"./"+base+condition[2])
	}
}

func (check *metadataCheck) rust() {
	const location, readme = "rust/logbrew/Cargo.toml", "rust/logbrew/README.md"
	manifestFound := check.requirePaths(location)
	check.requirePaths(readme)
	if !manifestFound {
		return
	}
	cargo := field(check.readTOML(location), "package")
	for _, pair := range [][2]string{
		{"name", "logbrew"}, {"version", check.catalog.Rust}, {"license", publicLicense},
		{"repository", sdkRepoURL}, {"readme", "README.md"},
	} {
		check.equal(location, "package."+pair[0], field(cargo, pair[0]), pair[1])
	}
	check.contains(location, "package.description", field(cargo, "description"), "LogBrew")
	check.require(listHas(field(cargo, "keywords"), "logbrew"), location+": keywords must include 'logbrew'")
	check.needles(check.read(readme), readme+": missing guidance ", "Metrics", "MetricEvent", "client.metric",
		"low-cardinality", "OpenTelemetry Span Exporter", "opentelemetry-exporter")
}

func (check *metadataCheck) python() {
	matches, _ := filepath.Glob(filepath.Join(check.root, "python", "logbrew_*", "pyproject.toml"))
	actual, expected := []string{}, []string{}
	for _, match := range matches {
		relative, _ := filepath.Rel(check.root, filepath.Dir(match))
		actual = append(actual, filepath.ToSlash(relative))
	}
	for _, release := range check.catalog.PyPI {
		expected = append(expected, release.Dir)
	}
	check.equal("python", "public package directories", newPySet(actual...), newPySet(expected...))
	for _, release := range check.catalog.PyPI {
		check.pythonPackage(release)
	}
}

func (check *metadataCheck) pythonPackage(release pypiRelease) {
	location := release.Dir + "/pyproject.toml"
	manifestFound := check.requirePaths(location)
	check.requirePaths(release.Dir + "/README.md")
	if !manifestFound {
		return
	}
	project := field(check.readTOML(location), "project")
	for _, pair := range [][2]string{
		{"name", release.Name}, {"version", release.Version}, {"license", publicLicense},
		{"readme", "README.md"}, {"requires-python", release.RequiresPython},
	} {
		check.equal(location, "project."+pair[0], field(project, pair[0]), pair[1])
	}
	check.contains(location, "project.description", field(project, "description"), release.Description)
	check.require(listHas(field(project, "authors"), map[string]any{"name": "LogBrew"}),
		location+": authors must include LogBrew")
	check.require(listHas(field(project, "keywords"), "logbrew"), location+": keywords must include 'logbrew'")
	check.equal(location, "project.dependencies", stringSet(field(project, "dependencies")),
		newPySet(release.Dependencies...))
	if release.OptionalDependencies != nil {
		expected, actual := map[string]pySet{}, map[string]pySet{}
		for extra, requirements := range release.OptionalDependencies {
			expected[extra] = newPySet(requirements...)
		}
		optional, _ := field(project, "optional-dependencies").(map[string]any)
		for extra, requirements := range optional {
			actual[extra] = stringSet(requirements)
		}
		check.equal(location, "project.optional-dependencies", actual, expected)
	}
	if urls, _ := field(project, "urls").(map[string]any); len(urls) > 0 {
		check.equal(location, "project.urls.Repository", urls["Repository"], sdkRepoURL)
	}
	source := release.Dir + "/src/" + release.Package
	check.requirePaths(source+"/py.typed", source+"/examples/__main__.py")
}

func (check *metadataCheck) goModules() {
	const goVersion = `(?m)^go 1\.24\.0$`
	manifestFound := check.requirePaths("go/logbrew/go.mod")
	check.requirePaths("go/logbrew/README.md")
	if !manifestFound {
		return
	}
	content := check.read("go/logbrew/go.mod")
	check.require(regexp.MustCompile(`(?m)^module github\.com/LogBrewCo/sdk/go/logbrew$`).MatchString(content),
		"go/logbrew/go.mod: unexpected module path")
	check.require(regexp.MustCompile(goVersion).MatchString(content), "go/logbrew/go.mod: expected go 1.24.0")
	for _, module := range [][3]string{
		{"otel", "v0.1.12", "go.opentelemetry.io/otel/sdk v1.41.0"},
		{"gin", "v0.1.12", "github.com/gin-gonic/gin v1.11.0"},
		{"asynq", "v0.1.12", "github.com/hibiken/asynq v0.26.0"},
	} {
		location := "go/logbrew/" + module[0]
		moduleFound := check.requirePaths(location + "/go.mod")
		check.requirePaths(location + "/README.md")
		if !moduleFound {
			continue
		}
		text := check.read(location + "/go.mod")
		for _, rule := range [][2]string{
			{"unexpected module path", `(?m)^module ` + regexp.QuoteMeta("github.com/LogBrewCo/sdk/go/logbrew/"+module[0]) + `$`},
			{"expected go 1.24.0", goVersion},
			{"expected parent LogBrew module requirement", `github\.com/LogBrewCo/sdk/go/logbrew ` + module[1]},
			{"expected framework requirement", regexp.QuoteMeta(module[2])},
		} {
			check.require(regexp.MustCompile(rule[1]).MatchString(text), location+"/go.mod: "+rule[0])
		}
	}
}

func (check *metadataCheck) c() {
	const header, source = "c/logbrew-c/include/logbrew.h", "c/logbrew-c/src/logbrew.c"
	check.requirePaths("c/logbrew-c/README.md")
	found := check.requirePaths(header)
	found = check.requirePaths(source) && found
	check.requirePaths("c/logbrew-c/src/logbrew_json.c", "c/logbrew-c/src/logbrew_context.c",
		"c/logbrew-c/src/logbrew_evidence.c", "c/logbrew-c/src/logbrew_metric.c", "c/logbrew-c/Makefile",
		"c/logbrew-c/examples/Makefile", "c/logbrew-c/examples/readme_example.c",
		"c/logbrew-c/examples/real_user_smoke.c", "c/logbrew-c/tests/test_logbrew.c",
		"c/logbrew-c/tests/test_rich_telemetry.c")
	if !found {
		return
	}
	check.needles(check.read(header), header+": missing public C SDK symbol ",
		`#define LOGBREW_C_VERSION "0.2.2"`, "typedef struct LogBrewClient LogBrewClient;", "logbrew_client_flush",
		"LogBrewRecordingTransport", "LogBrewMetricAttributes", "logbrew_client_metric",
		"LogBrewProductTimelineContext", "logbrew_client_product_action", "logbrew_client_network_milestone",
		"LogBrewHttpTransport", "logbrew_http_transport_init", "LogBrewTelemetryContext",
		"logbrew_client_issue_with_details", "logbrew_client_span_with_evidence")
	check.needles(check.read("c/logbrew-c/README.md"), "c/logbrew-c/README.md: missing guidance ",
		"Public C99 SDK", "LOGBREW_API_KEY", "logbrew_client_flush", "LogBrewMetricAttributes",
		"logbrew_client_metric", "logbrew_client_product_action", "logbrew_client_network_milestone",
		"logbrew_http_transport_init", "Rich investigation context", "logbrew_client_issue_with_details",
		"logbrew_client_span_with_evidence", "copy into your own native application")
}

func (check *metadataCheck) cpp() {
	const header, source = "cpp/logbrew-cpp/include/logbrew.hpp", "cpp/logbrew-cpp/src/logbrew.cpp"
	const traceExample = "cpp/logbrew-cpp/examples/trace_correlation.cpp"
	check.requirePaths("cpp/logbrew-cpp/README.md")
	found := check.requirePaths(header)
	found = check.requirePaths(source) && found
	check.requirePaths("cpp/logbrew-cpp/src/logbrew_http_transport.cpp", "cpp/logbrew-cpp/CMakeLists.txt",
		"cpp/logbrew-cpp/cmake/LogBrewConfig.cmake.in", "cpp/logbrew-cpp/Makefile",
		"cpp/logbrew-cpp/examples/Makefile", "cpp/logbrew-cpp/examples/readme_example.cpp",
		"cpp/logbrew-cpp/examples/real_user_smoke.cpp", traceExample, "cpp/logbrew-cpp/examples/http_transport.cpp",
		"cpp/logbrew-cpp/tests/test_logbrew.cpp", "cpp/logbrew-cpp/tests/test_rich_context.cpp")
	if !found {
		return
	}
	openTelemetry := []string{
		"OpenTelemetrySpanContext", "open_telemetry_span_context",
		"try_open_telemetry_span_context_from_span_pointer", "trace_context_from_opentelemetry_span_context",
		"trace_span_attributes_from_opentelemetry_span_context", "traceparent_headers",
	}
	check.needles(check.read(header), header+": missing public C++ SDK symbol ", slices.Concat([]string{
		`inline constexpr const char *version = "0.2.3"`, "class LogBrewClient", "MetadataValue",
		"ProductTimelineContext", "capture_product_action", "capture_network_milestone", "TraceContext",
		"TelemetryContext", "TelemetryScope", "EventOptions", "IssueDetails", "IssueStackFrame", "IssueBreadcrumb",
		"SpanEvidence", "SpanEvent", "SpanLink", "issue_frame_from_location", "TraceScope",
		"trace_context_from_traceparent",
	}, openTelemetry, []string{
		"MetricAttributes", "metric(", "class HttpTransport", "class RecordingTransport",
		"http_transport_default_endpoint", "class SdkException",
	})...)
	check.needles(check.read("cpp/logbrew-cpp/README.md"), "cpp/logbrew-cpp/README.md: missing guidance ",
		slices.Concat([]string{
			"Public C++17 SDK", "LOGBREW_API_KEY", "FetchContent", "LogBrew::LogBrew", "LogBrew::HttpTransport",
			"Metrics", "MetricAttributes", "client.metric", "low-cardinality", "Product Timelines",
			"Sending To LogBrew", "capture_product_action", "capture_network_milestone", "W3C Trace Correlation",
			"Rich Investigation Context", "Issue Evidence", "Span Evidence", "TelemetryContext", "IssueDetails",
			"SpanEvidence", "TraceScope", "trace_context_from_traceparent",
		}, openTelemetry, []string{
			"HttpTransport", "do not patch HTTP clients", "client.flush", "copy into your own native application",
		})...)
	if check.exists(traceExample) {
		check.needles(check.read(traceExample), traceExample+": missing ", openTelemetry[0], openTelemetry[1],
			openTelemetry[3])
	}
}

func (check *metadataCheck) objc() {
	const header, source = "objc/logbrew-objc/include/LogBrew.h", "objc/logbrew-objc/src/LogBrew.m"
	check.requirePaths("objc/logbrew-objc/README.md")
	found := check.requirePaths(header)
	found = check.requirePaths(source) && found
	for _, relative := range []string{
		"src/LBWTelemetryContext.h", "src/LBWTelemetryContext.m", "src/LBWInvestigationEvidence.h",
		"src/LBWInvestigationEvidence.m", "src/LBWDeliveryEngine.h", "src/LBWDeliveryEngine.m",
		"src/LBWDeliveryEnginePrivate.h", "src/LBWDeliveryEngineDurable.m", "src/LBWDurableDeliveryStore.h",
		"src/LBWDurableDeliveryStore.m", "src/LBWHTTPTransport.m", "Makefile", "examples/Makefile",
		"examples/readme_example.m", "examples/real_user_smoke.m", "tests/test_logbrew.m",
		"tests/test_durable_delivery.m", "tests/test_durable_delivery_recovery.m", "tests/test_rich_telemetry.m",
	} {
		check.requirePaths("objc/logbrew-objc/" + relative)
	}
	if !found {
		return
	}
	check.require(strings.Contains(check.read(source), `LogBrewObjectiveCVersion = @"0.2.3"`),
		source+": Objective-C source version must be 0.2.3")
	check.needles(check.read(header), header+": missing public Objective-C SDK symbol ",
		"LogBrewObjectiveCVersion", "LBWHTTPTransportDefaultEndpoint", "LBWClient", "LBWHTTPTransport",
		"LBWRecordingTransport", "LBWErrorStableCodeKey", "LBWTelemetry", "LBWTelemetryScope", "LBWIssueDiagnostics",
		"addBreadcrumb", "clearBreadcrumbs", "metricWithID", "captureProductActionWithID",
		"captureNetworkMilestoneWithID", "LBWAutomaticDeliveryOptions", "LBWDurableDeliveryOptions",
		"LBWDeliveryHealth", "startAutomaticDeliveryWithTransport", "enableDurableDeliveryWithOptions",
		"purgeDurableDeliveryWithError", "recoverAutomaticDeliveryWithError", "shutdownOwnedTransportWithError")
	check.needles(check.read("objc/logbrew-objc/README.md"), "objc/logbrew-objc/README.md: missing guidance ",
		"Shared Telemetry Context", "Issue Diagnostics", "Span Evidence", "Public Objective-C SDK",
		"LOGBREW_API_KEY", "Metrics", "metricWithID", "low-cardinality", "Sending To LogBrew", "LBWHTTPTransport",
		"flushWithTransport", "copyable source", "startAutomaticDeliveryWithTransport", "Durable Delivery (Opt-In)",
		"enableDurableDeliveryWithOptions", "deliveryHealth")
}

func (check *metadataCheck) mavenPOM(location, artifact, name string, compilerRelease bool, version string) {
	pomFound := check.requirePaths(location)
	check.requirePaths(filepath.ToSlash(filepath.Join(filepath.Dir(location), "README.md")))
	if !pomFound {
		return
	}
	project, ok := check.readXML(location)
	if !ok {
		return
	}
	for _, pair := range [][2]string{
		{"groupId", "co.logbrew"}, {"artifactId", artifact}, {"version", version}, {"packaging", "jar"},
		{"name", name}, {"url", sdkRepoURL},
	} {
		check.equal(location, pair[0], project.text(pair[0]), pair[1])
	}
	check.contains(location, "description", project.text("description"), "LogBrew")
	for _, pair := range [][2]string{
		{"licenses.license.name", publicLicense}, {"licenses.license.url", "https://opensource.org/license/mit"},
		{"developers.developer.name", "LogBrew"}, {"scm.url", sdkRepoURL},
	} {
		check.equal(location, pair[0], project.text(strings.Split(pair[0], ".")...), pair[1])
	}
	if compilerRelease {
		check.equal(location, "properties.maven.compiler.release",
			project.text("properties", "maven.compiler.release"), "11")
	}
	if artifact == "logbrew-kotlin" {
		found := false
		for _, dependency := range project.child("dependencies").all("dependency") {
			found = found || (dependency.text("groupId") == "org.jetbrains.kotlin" &&
				dependency.text("artifactId") == "kotlin-stdlib")
		}
		check.require(found, location+": dependencies must include org.jetbrains.kotlin:kotlin-stdlib")
	}
}

func (check *metadataCheck) unity() {
	const location = "unity/logbrew-unity/package.json"
	manifestFound := check.requirePaths(location)
	check.requirePaths("unity/logbrew-unity/README.md")
	openUPMFound := check.requirePaths(openUPMUnityMetadata)
	if !manifestFound {
		return
	}
	manifest := check.readJSON(location)
	for _, pair := range [][2]string{
		{"name", "co.logbrew.unity"}, {"version", check.catalog.Unity}, {"displayName", "LogBrew Unity SDK"},
		{"unity", "2021.3"}, {"license", publicLicense},
	} {
		check.equal(location, pair[0], manifest[pair[0]], pair[1])
	}
	check.contains(location, "description", manifest["description"], "LogBrew")
	check.equal(location, "author.name", field(manifest, "author", "name"), "LogBrew")
	check.equal(location, "repository.type", field(manifest, "repository", "type"), "git")
	check.equal(location, "repository.url", field(manifest, "repository", "url"), npmRepoURL)
	check.require(listHas(manifest["keywords"], "logbrew"), location+": keywords must include 'logbrew'")
	samples, _ := manifest["samples"].([]any)
	paths := []any{}
	for _, sample := range samples {
		if sample, ok := sample.(map[string]any); ok {
			paths = append(paths, sample["path"])
		}
	}
	check.equal(location, "samples paths", stringSet(paths), newPySet("Samples~/ReadmeExample", "Samples~/RealUserSmoke"))
	if openUPMFound {
		check.openUPM(manifest)
	}
}

func (check *metadataCheck) openUPM(manifest map[string]any) {
	metadata := check.readSimpleYAML(openUPMUnityMetadata)
	for _, pair := range []struct {
		field    string
		expected any
	}{
		{"name", manifest["name"]}, {"displayName", manifest["displayName"]},
		{"description", manifest["description"]}, {"repoUrl", sdkRepoURL}, {"trackingMode", "git"},
		{"parentRepoUrl", nil}, {"licenseSpdxId", manifest["license"]}, {"licenseName", "MIT License"},
		{"hunter", "furkanerday"}, {"gitTagPrefix", "co.logbrew.unity/"}, {"gitTagIgnore", ""},
		{"minVersion", manifest["version"]},
		{"image", "https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-espresso-bg-512.png"},
		{"readme", "main:unity/logbrew-unity/README.md"}, {"readme_zhCN", ""}, {"displayName_zhCN", ""},
		{"description_zhCN", ""},
	} {
		check.equal(openUPMUnityMetadata, pair.field, metadata[pair.field], pair.expected)
	}
	createdAt, ok := metadata["createdAt"].(int64)
	check.require(ok && createdAt > 0,
		openUPMUnityMetadata+": createdAt must be a positive Unix timestamp in milliseconds")
	check.equal(openUPMUnityMetadata, "aliases", metadata["aliases"], []string{})
	check.equal(openUPMUnityMetadata, "topics", metadata["topics"],
		[]string{"debugging-and-logging", "integration", "services", "testing", "utilities"})
}

// readSimpleYAML parses the string, list, integer, and null shape of the
// OpenUPM metadata file.
func (check *metadataCheck) readSimpleYAML(relative string) map[string]any {
	path := filepath.Join(check.root, relative)
	payload := map[string]any{}
	activeKey := ""
	for number, line := range strings.Split(lineBreaks.Replace(check.read(relative)), "\n") {
		stripped := strings.TrimSpace(line)
		if stripped == "" || strings.HasPrefix(stripped, "#") {
			continue
		}
		if activeKey != "" && strings.HasPrefix(line, "  - ") {
			list, _ := payload[activeKey].([]string)
			payload[activeKey] = append(list, unquoteYAML(strings.TrimSpace(line[4:])))
			continue
		}
		activeKey = ""
		key, value, found := strings.Cut(line, ":")
		if !found || strings.HasPrefix(line, " ") {
			check.failures = append(check.failures, fmt.Sprintf("%s:%d: unsupported YAML shape", path, number+1))
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		switch integer, integerError := strconv.ParseInt(value, 10, 64); {
		case value == "":
			activeKey = key
			payload[key] = []string{}
		case value == "null":
			payload[key] = nil
		case value == "[]":
			payload[key] = []string{}
		case integerError == nil && strings.Trim(value, "0123456789") == "":
			payload[key] = integer
		default:
			payload[key] = unquoteYAML(value)
		}
	}
	return payload
}

func unquoteYAML(value string) string {
	if len(value) >= 2 && value[0] == value[len(value)-1] && (value[0] == '\'' || value[0] == '"') {
		return value[1 : len(value)-1]
	}
	return value
}

func (check *metadataCheck) ruby() {
	const location, readme = "ruby/logbrew-ruby/logbrew-sdk.gemspec", "ruby/logbrew-ruby/README.md"
	const versionFile = "ruby/logbrew-ruby/lib/logbrew/version.rb"
	gemspecFound := check.requirePaths(location)
	check.requirePaths(readme, "ruby/logbrew-ruby/lib/logbrew-sdk.rb", versionFile,
		"ruby/logbrew-ruby/lib/logbrew/rails.rb", "ruby/logbrew-ruby/lib/logbrew/rails_integration.rb",
		"ruby/logbrew-ruby/tests/rails_integration.rb", "scripts/real_user_ruby_rails_smoke.sh")
	if !gemspecFound {
		return
	}
	text := check.read(location)
	repository := regexp.QuoteMeta(sdkRepoURL)
	for _, rule := range [][2]string{
		{"identity", `Gem::Specification\.new\("logbrew-sdk",\s*LogBrew::VERSION\)`},
		{"license", `spec\.license\s*=\s*"` + publicLicense + `"`},
		{"author", `spec\.authors\s*=\s*\["LogBrew"\]`},
		{"homepage", `spec\.homepage\s*=\s*"` + repository + `"`},
		{"source_code_uri", `"source_code_uri"\s*=>\s*"` + repository + `"`},
		{"required_ruby_version", `spec\.required_ruby_version\s*=\s*">= 2\.6"`},
	} {
		check.require(regexp.MustCompile(rule[1]).MatchString(text), location+": missing "+rule[0]+" metadata")
	}
	check.needles(text, location+": files must include ", "README.md", "examples/Makefile")
	if check.exists(versionFile) {
		check.require(strings.Contains(check.read(versionFile), `VERSION = "`+check.catalog.RubyGems+`"`),
			versionFile+": version must match the gemspec")
	}
	if check.exists(readme) {
		check.needles(check.read(readme), readme+": missing guidance ", "Rails Quick Start",
			"LOGBREW_SERVER_API_KEY", "logbrew projects create rails-service", "logbrew doctor --project",
			"logbrew traces --project")
	}
}

func (check *metadataCheck) phpManifest(location, readme, autoload string) map[string]any {
	manifestFound := check.requirePaths(location)
	check.requirePaths(readme)
	if !manifestFound {
		return map[string]any{}
	}
	manifest := check.readJSON(location)
	for _, pair := range [][3]any{
		{"name", manifest["name"], "logbrew/sdk"},
		{"type", manifest["type"], "library"},
		{"license", manifest["license"], publicLicense},
		{"require.php", field(manifest, "require", "php"), "^8.2"},
		{"require.psr/log", field(manifest, "require", "psr/log"), "^3.0"},
		{`autoload.psr-4.LogBrew\`, field(manifest, "autoload", "psr-4", `LogBrew\`), autoload},
	} {
		check.equal(location, pair[0].(string), pair[1], pair[2])
	}
	check.contains(location, "description", manifest["description"], "LogBrew")
	return manifest
}

func (check *metadataCheck) php() {
	const readme, source = "php/logbrew-php/README.md", sdkRepoURL + "/tree/main/php/logbrew-php"
	check.phpManifest("php/logbrew-php/composer.json", readme, "src/")
	manifest := check.phpManifest("composer.json", readme, "php/logbrew-php/src/")
	for _, pair := range [][3]any{
		{"readme", manifest["readme"], readme},
		{"homepage", manifest["homepage"], source},
		{"support.issues", field(manifest, "support", "issues"), sdkRepoURL + "/issues"},
		{"support.source", field(manifest, "support", "source"), source},
	} {
		check.equal("composer.json", pair[0].(string), pair[1], pair[2])
	}
	check.require(listHas(manifest["keywords"], "logbrew"), "composer.json: keywords must include 'logbrew'")
}

func (check *metadataCheck) swift() {
	const readme = "swift/logbrew-swift/README.md"
	readmeFound := check.requirePaths(readme)
	for _, relative := range []string{
		"Sources/LogBrew/DurableDeliveryStore.swift", "Sources/LogBrew/DurableDeliveryStoreRecovery.swift",
		"Sources/LogBrew/DeliveryEngine.swift", "Sources/LogBrew/DeliveryEngineDurable.swift",
		"Sources/LogBrew/DeliveryEngineAutomatic.swift", "Sources/LogBrew/DeliveryEngineQueue.swift",
		"Sources/LogBrew/DeliveryLifecycle.swift", "Tests/LogBrewTests/AutomaticDeliveryTests.swift",
		"Tests/LogBrewTests/AutomaticDeliveryLifecycleTests.swift",
		"Tests/LogBrewTests/AutomaticDeliveryTestSupport.swift",
		"Tests/LogBrewTests/DurableDeliveryPublicContractTests.swift",
		"Tests/LogBrewTests/DurableDeliveryFailureTests.swift", "Tests/LogBrewTests/DurableDeliveryRecoveryTests.swift",
	} {
		check.requirePaths("swift/logbrew-swift/" + relative)
	}
	if readmeFound {
		check.needles(check.read(readme), readme+": missing guidance ", "startAutomaticDelivery",
			"AutomaticDeliveryOptions", "Durable Delivery (Opt-In)", "DurableDeliveryOptions", "enableDurableDelivery",
			"purgeDurableDelivery", "deliveryHealth")
	}
	shared := []string{`name: "logbrew-swift"`, ".macOS(.v13)", ".iOS(.v15)", `.library(name: "LogBrew", targets: ["LogBrew"])`}
	for _, manifest := range []struct {
		location string
		entries  []string
	}{
		{"swift/logbrew-swift/Package.swift", append(slices.Clone(shared),
			`.executable(name: "ReadmeExample", targets: ["ReadmeExample"])`,
			`.executable(name: "RealUserSmoke", targets: ["RealUserSmoke"])`, `.target(name: "LogBrew")`,
			`.testTarget(name: "LogBrewTests", dependencies: ["LogBrew"])`)},
		{"Package.swift", append(slices.Clone(shared), `.library(name: "LogBrewCrash", targets: ["LogBrewCrash"])`,
			`.library(name: "LogBrewObjC", targets: ["LogBrewObjC"])`, `path: "objc/logbrew-objc"`,
			`path: "swift/logbrew-swift/Sources/LogBrew"`, `path: "swift/logbrew-swift/Sources/LogBrewCrash"`,
			`path: "swift/logbrew-swift/Tests/LogBrewTests"`, `path: "swift/logbrew-swift/Tests/LogBrewCrashTests"`)},
	} {
		if check.requirePaths(manifest.location) {
			check.needles(check.read(manifest.location), manifest.location+": missing manifest entry ",
				manifest.entries...)
		}
	}
}

// xmlElement keeps what the checks read from XML: names, attributes keyed as
// ElementTree keys them, the text before the first child, and child elements.
type xmlElement struct {
	value      *string
	attributes map[string]string
	name       string
	space      string
	children   []*xmlElement
}

const xmlNamespace = "http://www.w3.org/XML/1998/namespace"

// boundName reports whether a name's namespace prefix was declared in scope;
// the decoder leaves an undeclared prefix in place of its namespace.
func boundName(name xml.Name, scopes [][]string) bool {
	return name.Space == "" || name.Space == xmlNamespace ||
		slices.ContainsFunc(scopes, func(declared []string) bool { return slices.Contains(declared, name.Space) })
}

// parseXML reads text as UTF-8 whatever encoding the declaration names, and
// rejects an XML declaration after the start of the document, like
// ElementTree.fromstring on decoded text.
func parseXML(data []byte) (*xmlElement, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.CharsetReader = func(_ string, input io.Reader) (io.Reader, error) { return input, nil }
	start := int64(len(data) - len(bytes.TrimPrefix(data, []byte("\ufeff"))))
	var root *xmlElement
	var stack []*xmlElement
	var scopes [][]string
	for {
		offset := decoder.InputOffset()
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if instruction, ok := token.(xml.ProcInst); ok && instruction.Target == "xml" && offset != start {
			err = errors.New("XML declaration not at start of document")
		}
		if err != nil {
			return nil, err
		}
		switch token := token.(type) {
		case xml.StartElement:
			names, declared := []xml.Name{token.Name}, []string{}
			element := &xmlElement{name: token.Name.Local, space: token.Name.Space, attributes: map[string]string{}}
			for _, attribute := range token.Attr {
				key := attribute.Name.Local
				if attribute.Name.Space != "" {
					key = "{" + attribute.Name.Space + "}" + key
				}
				if attribute.Name.Space == "xmlns" || key == "xmlns" {
					declared = append(declared, attribute.Value)
					continue
				}
				if _, found := element.attributes[key]; found {
					return nil, errors.New("duplicate attribute")
				}
				names, element.attributes[key] = append(names, attribute.Name), attribute.Value
			}
			scopes = append(scopes, declared)
			if slices.ContainsFunc(names, func(name xml.Name) bool { return !boundName(name, scopes) }) {
				return nil, errors.New("unbound prefix")
			}
			switch {
			case len(stack) > 0:
				parent := stack[len(stack)-1]
				parent.children = append(parent.children, element)
			case root != nil:
				return nil, errors.New("junk after document element")
			default:
				root = element
			}
			stack = append(stack, element)
		case xml.EndElement:
			stack, scopes = stack[:len(stack)-1], scopes[:len(scopes)-1]
		case xml.CharData:
			text := string(token)
			if offset == 0 {
				text = strings.TrimPrefix(text, "\ufeff")
			}
			if len(stack) == 0 && strings.Trim(text, " \t\r\n") != "" {
				return nil, errors.New("junk outside the document element")
			}
			if len(stack) > 0 && len(stack[len(stack)-1].children) == 0 {
				top := stack[len(stack)-1]
				if top.value != nil {
					text = *top.value + text
				}
				top.value = &text
			}
		}
	}
	if root == nil {
		return nil, errors.New("no element found")
	}
	return root, nil
}

func (check *metadataCheck) readXML(relative string) (*xmlElement, bool) {
	path := filepath.Join(check.root, relative)
	data, err := os.ReadFile(path)
	var root *xmlElement
	if err == nil {
		root, err = parseXML(data)
	}
	if err != nil {
		check.failures = append(check.failures, path+": invalid XML: "+err.Error())
		return nil, false
	}
	return root, true
}

func (element *xmlElement) child(name string) *xmlElement {
	if element == nil {
		return nil
	}
	for _, child := range element.children {
		if child.name == name {
			return child
		}
	}
	return nil
}

func (element *xmlElement) all(name string) []*xmlElement {
	var matches []*xmlElement
	if element != nil {
		for _, child := range element.children {
			if child.name == name {
				matches = append(matches, child)
			}
		}
	}
	return matches
}

// iter returns the element and its descendants in document order.
func (element *xmlElement) iter() []*xmlElement {
	if element == nil {
		return nil
	}
	elements := []*xmlElement{element}
	for _, child := range element.children {
		elements = append(elements, child.iter()...)
	}
	return elements
}

// attribute returns an attribute's value, or nil when it is missing.
func (element *xmlElement) attribute(name string) any {
	if value, found := element.attributes[name]; found {
		return value
	}
	return nil
}

// text follows child names and returns the trimmed text, or nil when an
// element or its text is missing.
func (element *xmlElement) text(names ...string) any {
	for _, name := range names {
		element = element.child(name)
	}
	if element == nil || element.value == nil {
		return nil
	}
	return strings.TrimSpace(*element.value)
}

// rawText returns the untrimmed text of the first child with the name, or nil.
func (element *xmlElement) rawText(name string) any {
	child := element.child(name)
	if child == nil || child.value == nil {
		return nil
	}
	return *child.value
}

func compatibleDependencyRange(version string) string {
	parts := strings.SplitN(version, ".", 3)
	if len(parts) < 2 {
		return ""
	}
	major, majorError := strconv.Atoi(parts[0])
	minor, minorError := strconv.Atoi(parts[1])
	if majorError != nil || minorError != nil {
		return ""
	}
	upper := strconv.Itoa(major+1) + ".0.0"
	if major == 0 {
		upper = "0." + strconv.Itoa(minor+1) + ".0"
	}
	return "[" + version + ", " + upper + ")"
}

func (check *metadataCheck) dotnet(versions map[string]string) {
	check.nugetCatalog()
	catalogVersions := map[string]string{}
	for _, release := range check.catalog.NuGet {
		catalogVersions[release.ID] = release.Version
	}
	version := func(id string) string { return cmpOr(versions[id], catalogVersions[id]) }
	examples := []string{
		"FirstUsefulTelemetry.cs", "ActivityTraceCorrelation.cs", "ActivitySourceListenerTelemetry.cs",
		"DependencySpansTelemetry.cs", "DbCommandTelemetry.cs", "HttpClientOutboundTelemetry.cs",
		"AspNetCoreRequestTelemetry.cs",
	}
	core := dotnetPackage{
		location: "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj",
		required: []string{"dotnet/logbrew-dotnet/README.md"},
		expected: [][2]string{
			{"TargetFrameworks", "netstandard2.0;net8.0"}, {"PackageId", "LogBrew"}, {"Version", version("LogBrew")},
		},
		icon: "logbrew-logo-transparent-128.png",
		needles: [][2]string{{
			`PackageVersion Condition="'$(LogBrewProjectReferenceVersion)' != ''"`,
			"core package must expose the bounded project-reference pack seam",
		}},
	}
	for _, example := range examples {
		core.required = append(core.required, "dotnet/logbrew-dotnet/examples/"+example)
		core.needles = append(core.needles, [2]string{"examples/" + example, "package must include examples/" + example})
	}
	check.dotnetPackage(core)
	const httpClient = "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/"
	check.dotnetPackage(dotnetPackage{
		location: httpClient + "LogBrew.HttpClient.csproj",
		required: []string{httpClient + "README.md", httpClient + "examples/HttpClientFactoryCorrelation.cs"},
		expected: [][2]string{
			{"TargetFrameworks", "netstandard2.0;net8.0"}, {"IsAotCompatible", "true"}, {"SignAssembly", "false"},
			{"LogBrewCoreDependencyVersion", compatibleDependencyRange(version("LogBrew"))},
			{"PackageId", "LogBrew.HttpClient"}, {"Version", version("LogBrew.HttpClient")},
		},
		needles: [][2]string{
			{`ProjectReference Include="../LogBrew/LogBrew.csproj"`, "package must depend on the core LogBrew project"},
			{`PackageReference Include="Microsoft.Extensions.Http"`, "package must depend on IHttpClientFactory APIs"},
			{"examples/HttpClientFactoryCorrelation.cs", "package must include its selected-client example"},
		},
	})
	for _, integration := range [][]string{
		{"LogBrew.AspNetCore", "net10.0", "AspNetCoreMiddlewareTelemetry.cs",
			`FrameworkReference Include="Microsoft.AspNetCore.App"`},
		{"LogBrew.EntityFrameworkCore", "net10.0", "EntityFrameworkCoreCommandTelemetry.cs",
			`PackageReference Include="Microsoft.EntityFrameworkCore.Relational"`},
		{"LogBrew.Hangfire", "netstandard2.0", "HangfireJobTelemetry.cs", `PackageReference Include="Hangfire.Core"`,
			`PackageReference Include="Newtonsoft.Json"`},
		{"LogBrew.StackExchangeRedis", "netstandard2.0", "StackExchangeRedisCommandTelemetry.cs",
			`PackageReference Include="StackExchange.Redis"`},
		{"LogBrew.OpenTelemetry", "netstandard2.0", "OpenTelemetrySpanProcessorTelemetry.cs",
			`PackageReference Include="OpenTelemetry"`},
	} {
		id, example := integration[0], integration[2]
		packageRoot := "dotnet/logbrew-dotnet/src/" + id
		needles := [][2]string{
			{`ProjectReference Include="../LogBrew/LogBrew.csproj"`, "package must depend on the core LogBrew project"},
		}
		for _, dependency := range integration[3:] {
			needles = append(needles, [2]string{dependency, "package dependency metadata is missing " + dependency})
		}
		check.dotnetPackage(dotnetPackage{
			location: packageRoot + "/" + id + ".csproj",
			required: []string{packageRoot + "/README.md", "dotnet/logbrew-dotnet/examples/" + example},
			expected: [][2]string{{"TargetFramework", integration[1]}, {"PackageId", id}, {"Version", version(id)}},
			needles:  append(needles, [2]string{"examples/" + example, "package must include examples/" + example}),
		})
	}
}

type dotnetPackage struct {
	location string
	icon     string
	required []string
	expected [][2]string
	needles  [][2]string
}

func (check *metadataCheck) dotnetPackage(spec dotnetPackage) {
	icon := cmpOr(spec.icon, "logbrew-logo-espresso-bg-128.png")
	for _, relative := range slices.Concat([]string{spec.location}, spec.required, []string{"assets/brand/" + icon}) {
		check.require(check.exists(relative), "missing "+relative)
	}
	if !check.exists(spec.location) {
		return
	}
	project, ok := check.readXML(spec.location)
	if !ok {
		return
	}
	properties := project.child("PropertyGroup")
	for _, pair := range slices.Concat(spec.expected, [][2]string{
		{"Authors", "LogBrew"}, {"Company", "LogBrew"}, {"PackageLicenseExpression", publicLicense},
		{"PackageProjectUrl", sdkRepoURL}, {"RepositoryUrl", sdkRepoURL}, {"PackageReadmeFile", "README.md"},
		{"PackageIcon", icon},
	}) {
		actual := properties.rawText(pair[0])
		check.require(actual == any(pair[1]),
			fmt.Sprintf("%s: expected %s=%s, found %s", spec.location, pair[0], pyRepr(pair[1]), pyRepr(actual)))
	}
	description, _ := properties.rawText("Description").(string)
	check.require(strings.Contains(description, "LogBrew"), spec.location+": expected Description to contain 'LogBrew'")
	text := check.read(spec.location)
	for _, needle := range spec.needles {
		check.require(strings.Contains(text, needle[0]), spec.location+": "+needle[1])
	}
}

func (check *metadataCheck) nugetCatalog() {
	projects, _ := filepath.Glob(filepath.Join(check.root, "dotnet", "logbrew-dotnet", "src", "*", "*.csproj"))
	discovered := map[string]string{}
	for _, path := range projects {
		relative, _ := filepath.Rel(check.root, path)
		project, ok := check.readXML(relative)
		if !ok {
			continue
		}
		properties := project.child("PropertyGroup")
		if packable, _ := properties.rawText("IsPackable").(string); strings.ToLower(packable) == "false" {
			continue
		}
		id, _ := properties.rawText("PackageId").(string)
		if id == "" {
			check.failures = append(check.failures, path+": public package project must declare PackageId")
			continue
		}
		discovered[id] = filepath.ToSlash(relative)
	}
	expected := map[string]string{}
	for _, release := range check.catalog.NuGet {
		expected[release.ID] = release.project()
	}
	for _, id := range sortedKeys(expected) {
		if _, found := discovered[id]; !found {
			check.failures = append(check.failures, "NuGet release catalog package is missing from source: "+id)
		}
	}
	for _, id := range sortedKeys(discovered) {
		if _, found := expected[id]; !found {
			check.failures = append(check.failures, "NuGet release catalog is missing public package: "+id)
		}
	}
	for _, id := range sortedKeys(expected) {
		if found, ok := discovered[id]; ok && found != expected[id] {
			check.failures = append(check.failures, "NuGet release catalog path mismatch for "+id+
				": expected "+expected[id]+", found "+found)
		}
	}
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// after returns the text after the first separator, or all of it when the
// separator is missing; before returns the text before it.
func after(text, separator string) string {
	_, rest, found := strings.Cut(text, separator)
	return map[bool]string{true: rest, false: text}[found]
}

func before(text, separator string) string {
	head, _, _ := strings.Cut(text, separator)
	return head
}

func (check *metadataCheck) releaseWorkflows() {
	check.requirePaths("scripts/real_user_dotnet_aspnetcore_public_nuget_smoke.sh")
	if check.requirePaths(reconcilePublicWorkflow) {
		check.reconcileWorkflow(check.read(reconcilePublicWorkflow))
	}
	if check.requirePaths(publishReleaseWorkflow) {
		check.publishReleaseWorkflow(check.read(publishReleaseWorkflow))
	}
	if check.requirePaths(publishPackagesWorkflow) {
		check.publishPackagesWorkflow(check.read(publishPackagesWorkflow))
	}
	for _, relative := range []string{"docs/github-actions.md", ".github/publishing/trusted-publishers.md"} {
		if !check.requirePaths(relative) {
			continue
		}
		docs := check.read(relative)
		check.require(strings.Contains(docs, "release tag's commit") && strings.Contains(docs, "historical tags") &&
			strings.Contains(docs, "run_native_verifier release-versions"),
			relative+": missing release workflow safety warning")
		if relative == ".github/publishing/trusted-publishers.md" {
			check.needles(docs, relative+": missing trusted publisher npm package ", check.catalog.npmNames()...)
			for _, release := range check.catalog.PyPI {
				check.require(strings.Contains(docs, release.Name),
					relative+": missing trusted publisher PyPI package "+release.Name)
			}
		}
	}
}

func (check *metadataCheck) reconcileWorkflow(text string) {
	check.described(text, reconcilePublicWorkflow, [][2]string{
		{"explicit dispatch", "workflow_dispatch:"},
		{"read-only action permission", "actions: read"},
		{"read-only content permission", "contents: read"},
		{"immutable source input", "ref: ${{ inputs.ref }}"},
		{"protected control input", "ref: ${{ github.workflow_sha }}"},
		{"protected branch binding", `[[ "$CONTROL_REF" != "refs/heads/main"`},
		{"discarded checkout authentication state", checkoutDiscardsAuth},
		{"publication boundary authentication", "release-checks publication-run"},
		{"Python artifact reconciliation", "resolve-public"},
		{"protected Python artifact creation", "release-artifacts python create"},
		{"NuGet artifact reconciliation", "release-artifacts nuget-public"},
		{"NuGet immutable source binding", `--source-root "$GITHUB_WORKSPACE"`},
		{"Python exact-byte install", "real_user_python_public_pypi_smoke.sh"},
		{"NuGet exact-byte install", "real_user_dotnet_selected_public_nuget_smoke.sh"},
	})
	for _, forbidden := range []string{
		"id-token: write", "environment: release", "gh-action-pypi-publish", "dotnet nuget push", "nuget/login",
	} {
		check.require(!strings.Contains(text, forbidden), reconcilePublicWorkflow+": reconciliation cannot publish")
	}
}

func (check *metadataCheck) publishReleaseWorkflow(text string) {
	check.described(text, publishReleaseWorkflow, [][2]string{
		{"release ref checkout", "Check out release ref"},
		{"scoped GitHub Release skip guard", `if [[ "$RELEASE_TAG" == */* ]]; then`},
		{"scoped GitHub Release publish disable", `publish_packages="false"`},
		{"repo-wide SemVer release gate",
			`elif [[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then`},
		{"repo-wide version guard", `"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" release-versions "$REF" .`},
		{"publish dispatch output guard", "if: ${{ steps.release.outputs.publish_packages == 'true' }}"},
		{"scoped GitHub Release summary", "Skipped package publishing for scoped GitHub Release"},
		{"Maven selected-artifact release input", "maven_artifacts:"},
		{"Maven selected-artifact dispatch", `-f maven_artifacts="$MAVEN_ARTIFACTS"`},
		{"Maven release selector environment binding", "INPUT_MAVEN_ARTIFACTS: " + mavenSelectorInput},
		{"Maven release selector canonicalization", "release-plan maven canonicalize"},
		{"Maven release selector environment input", "--artifacts-env INPUT_MAVEN_ARTIFACTS"},
		{"Maven release canonical output", `printf 'maven_artifacts=%s\n' "$maven_artifacts"`},
		{"NuGet selected-package release input", "nuget_packages:"},
		{"NuGet selected-package dispatch", `-f nuget_packages="$NUGET_PACKAGES"`},
		{"NuGet release selector environment binding", "INPUT_NUGET_PACKAGES: " + nugetSelectorInput},
		{"NuGet release selector canonicalization", "release-plan nuget canonicalize"},
		{"NuGet release canonical output", `printf 'nuget_packages=%s\n' "$nuget_packages"`},
	})
	script := after(before(after(text, "name: Resolve release publish inputs"),
		"- name: Guard repo-wide release package versions"), "run: |")
	for _, selector := range []struct{ name, input, variable string }{
		{"Maven", mavenSelectorInput, "maven_artifacts"},
		{"NuGet", nugetSelectorInput, "nuget_packages"},
	} {
		check.require(!strings.Contains(script, selector.input),
			publishReleaseWorkflow+": "+selector.name+" selector must not be interpolated into shell")
		check.require(!strings.Contains(script, selector.variable+`="$INPUT_`+strings.ToUpper(selector.variable)+`"`) &&
			!strings.Contains(script, `echo "`+selector.variable+"=$"+selector.variable+`"`),
			publishReleaseWorkflow+": "+selector.name+" selector must be canonical before output")
	}
}

func (check *metadataCheck) publishPackagesWorkflow(text string) {
	npmPublisher := ""
	if check.requirePaths("tools/npm-publish/publish.mjs") {
		npmPublisher = check.read("tools/npm-publish/publish.mjs")
	}
	check.described(text, publishPackagesWorkflow, [][2]string{
		{"immutable verify source binding", "id: verify-source"},
		{"protected verify-control checkout", "- name: Check out protected verify control"},
		{"verify-control repository binding", "repository: ${{ github.repository }}"},
		{"verify-control workflow SHA binding", "ref: ${{ github.workflow_sha }}"},
		{"verify-control isolated path", "path: .release-control"},
		{"verify-control runtime binding", "- name: Bind protected verify control"},
		{"verify-control expected SHA", "RELEASE_CONTROL_SHA: ${{ github.workflow_sha }}"},
		{"verify source expected SHA", "RELEASE_SOURCE_SHA: ${{ steps.verify-source.outputs.sha }}"},
		{"protected registry verifier execution", protectedRegistryCheck},
		{"protected Swift verifier execution",
			`"$GITHUB_WORKSPACE/.release-control/scripts/real_user_swiftpm_public_smoke.sh"`},
	})
	if check.requirePaths(publishNuGetWorkflow) {
		nuget := check.read(publishNuGetWorkflow)
		text += "\n" + nuget
		check.described(nuget, publishNuGetWorkflow, [][2]string{
			{"release source binding", "id: release-source"},
			{"protected release-control checkout", "- name: Check out protected release control"},
			{"release-control repository binding", "repository: ${{ github.repository }}"},
			{"release-control workflow SHA binding", "ref: ${{ github.workflow_sha }}"},
			{"release-control isolated path", "path: .release-control"},
			{"release-control runtime binding", "- name: Bind protected release control"},
			{"release-control expected SHA", "RELEASE_CONTROL_SHA: ${{ github.workflow_sha }}"},
			{"release source expected SHA", "RELEASE_SOURCE_SHA: ${{ steps.release-source.outputs.sha }}"},
			{"release source runtime verification", `git -C "$GITHUB_WORKSPACE" rev-parse --verify 'HEAD^{commit}'`},
			{"release-control runtime verification", `git -C "$control_root" rev-parse --verify 'HEAD^{commit}'`},
			{"protected registry checker execution", protectedRegistryCheck},
		})
		check.require(strings.Count(nuget, checkoutDiscardsAuth) >= 2,
			publishNuGetWorkflow+": both checkouts must discard authentication state")
		check.require(strings.Count(nuget, protectedRegistryCheck) == 2,
			publishNuGetWorkflow+": both NuGet registry checks must use protected release control")
	}
	planScript := before(after(text, "- name: Plan selected Maven artifacts"), "- name: Check selected Maven version collisions")
	check.require(!strings.Contains(after(planScript, "run: |"), mavenSelectorInput),
		publishPackagesWorkflow+": Maven selector must not be interpolated into shell")
	if strings.Contains(text, "\n  maven:\n") && strings.Contains(text, "\n  verify:\n") {
		check.mavenJob(before(after(text, "\n  maven:\n"), "\n  verify:\n"))
	}
	needles := slices.Clone(publishNeedles)
	for _, release := range check.catalog.NuGet {
		needles = append(needles, [2]string{"NuGet " + release.ID + " version output", release.VersionOutput + "="})
	}
	check.described(text+"\n"+npmPublisher, publishPackagesWorkflow, needles)
	for _, entry := range check.catalog.NPM {
		check.require(strings.Contains(text, entry[0]), publishPackagesWorkflow+": missing npm package dir "+entry[0])
	}
	for _, release := range check.catalog.PyPI {
		check.require(strings.Contains(text, release.Dir), publishPackagesWorkflow+": missing PyPI package dir "+release.Dir)
	}
}

func (check *metadataCheck) mavenJob(job string) {
	positions := []int{}
	for _, step := range []string{
		"Upload Maven Central deployment bundle", "Wait for Maven Central deployment",
		"Verify Maven Central publication", "Verify public Maven Central install",
	} {
		positions = append(positions, strings.Index(job, step))
	}
	check.require(slices.Min(positions) >= 0 && slices.IsSorted(positions) && len(slices.Compact(slices.Clone(positions))) == 4,
		publishPackagesWorkflow+": Maven deployment status must complete before public verification")
	check.require(strings.Count(job, "https://central.sonatype.com/api/v1/publisher/upload") == 1,
		publishPackagesWorkflow+": Maven upload must execute exactly once")
	check.require(strings.Contains(job, checkoutDiscardsAuth),
		publishPackagesWorkflow+": Maven release-control checkout must discard authentication state")
	check.require(strings.Contains(job, "id: maven-release-control") &&
		strings.Count(job, `sha256sum "$control_script"`) == 3 && strings.Count(job, "verify_control_script") == 3,
		publishPackagesWorkflow+": Maven release-control script bytes must be rebound before both executions")
}

var publishNeedles = [][2]string{
	{"NuGet package version output", "id: nuget-version"},
	{"NuGet HttpClient pack", "dotnet pack dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj"},
	{"NuGet selected package plan", "release-plan nuget create"},
	{"NuGet selected package plan validation", "release-plan nuget validate"},
	{"NuGet selected package iteration", "--format projects"},
	{"NuGet XML documentation pack", "-p:GenerateDocumentationFile=true"},
	{"NuGet HttpClient documentation pack", "httpclient_pack_args="},
	{"NuGet symbol pack", "-p:SymbolPackageFormat=snupkg"},
	{"NuGet source commit pack", "-p:RepositoryCommit=$source_commit"},
	{"NuGet Source Link pack", "-p:EnableSourceLink=true"},
	{"NuGet artifact validation", "release-artifacts dotnet"},
	{"NuGet artifact digest receipt", "steps.nuget-artifacts.outputs.httpclient_content_sha256"},
	{"NuGet collision preflight", "--expect-absent"},
	{"NuGet bounded core dependency", `--dependency-range "LogBrew.HttpClient:LogBrew=`},
	{"NuGet HttpClient compatibility receipt", "real_user_dotnet_httpclient_package_compatibility_smoke.sh"},
	{"NuGet one-package publish loop", "while IFS= read -r package_path"},
	{"NuGet duplicate-safe publish", "--skip-duplicate"},
	{"NuGet symbol publish", "--symbol-source https://api.nuget.org/v3/index.json"},
	{"NuGet public install smoke", "bash scripts/real_user_dotnet_selected_public_nuget_smoke.sh"},
	{"NuGet ASP.NET Core lifecycle smoke", "bash scripts/real_user_dotnet_aspnetcore_public_nuget_smoke.sh"},
	{"Python artifact manifest", "release-artifacts python create"},
	{"Python packed install receipt", "real_user_python_public_pypi_smoke.sh --manifest"},
	{"Python packed artifact root", "--artifact-root dist/pypi"},
	{"Python manifest receipt upload", "Upload Python release manifest"},
	{"Python public install receipt", "Verify public PyPI installs"},
	{"Python Flask exact release version", "logbrew-flask=${{ steps.pypi-version.outputs.flask_version }}"},
	{"SwiftPM exact revision receipt", "LOGBREW_SWIFTPM_EXPECTED_REVISION"},
	{"SwiftPM exact source digest receipt", "LOGBREW_SWIFTPM_EXPECTED_SOURCE_SHA256"},
	{"SwiftPM installed products receipt", "real_user_swiftpm_public_smoke.sh"},
	{"verify target exact version input", "verify_version:"},
	{"verify target exact version argument", `verify_args+=(--version "$VERIFY_VERSION")`},
	{"verify target exact released package set", "verify_args=(--target all --require-released-package-set)"},
	{"verify target npm version override", `append_values --npm-version "$VERIFY_NPM_VERSIONS"`},
	{"verify target PyPI version override", `append_values --pypi-version "$VERIFY_PYPI_VERSIONS"`},
	{"verify target NuGet version override", `append_values --nuget-version "$VERIFY_NUGET_VERSIONS"`},
	{"verify target Maven artifact filter input", "verify_maven_artifacts:"},
	{"verify target Maven version input", "verify_maven_versions:"},
	{"verify target Maven artifact filter", `append_values --maven-artifact "$VERIFY_MAVEN_ARTIFACTS"`},
	{"verify target Maven version override", `append_values --maven-version "$VERIFY_MAVEN_VERSIONS"`},
	{"verify target Maven override include", `-n "$VERIFY_MAVEN_ARTIFACTS" || -n "$VERIFY_MAVEN_VERSIONS"`},
	{"npm OIDC permission", "id-token: write"},
	{"npm OIDC audience", "npm:registry.npmjs.org"},
	{"npm OIDC exchange", "/-/npm/v1/oidc/token/exchange/package/"},
	{"npm package-page guard", "npm trusted publishing requires existing package pages"},
	{"npm explicit package selection", "Bun publication requires an explicit npm_packages selection"},
	{"npm provenance generation", "provenance: true"},
	{"npm provenance registry verification", "--require-npm-provenance"},
	{"crates.io package version output", "id: crate-version"},
	{"crates.io manifest version reader", `"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" release-versions --rust .`},
	{"crates.io exact public version verification",
		`--target crates --version "${{ steps.crate-version.outputs.version }}"`},
	{"Maven Central public install smoke", "bash scripts/real_user_maven_central_public_smoke.sh"},
	{"Maven Central generated publishing-values hint", "generated Central Portal publishing values"},
	{"Maven Central auth preflight", "bash scripts/check_maven_central_auth_preflight.sh"},
	{"Maven immutable release source binding", "- name: Bind immutable Maven release source"},
	{"Maven protected release-control checkout", "- name: Check out protected Maven release control"},
	{"Maven release-control workflow SHA binding", "ref: ${{ github.workflow_sha }}"},
	{"Maven release-control isolated path", "path: .release-control"},
	{"Maven release-control runtime binding", "- name: Bind protected Maven release control"},
	{"Maven private deployment identifier capture", "capture --deployment-id-file"},
	{"Maven authenticated deployment wait", "wait --deployment-id-file"},
	{"Maven bounded deployment deadline", "--timeout-seconds 3600"},
	{"Maven selected-artifact input", "maven_artifacts:"},
	{"Maven selected-artifact plan", "release-plan maven create"},
	{"Maven selected-artifact environment input", "MAVEN_ARTIFACTS_INPUT: " + mavenSelectorInput},
	{"Maven selected-artifact parser input", "--artifacts-env MAVEN_ARTIFACTS_INPUT"},
	{"Maven selected-version collision preflight", "--maven-plan-scope selected"},
	{"Maven exact dependency closure preflight", "--maven-plan-scope dependencies"},
	{"Maven exact bundle manifest", "--manifest"},
	{"Maven selected public install smoke", "real_user_maven_central_public_smoke.sh --plan"},
}
