package main

import (
	"bytes"
	"path"
	"strings"
	"testing"
)

func manifestText(relative, version string) string {
	switch name := path.Base(relative); {
	case name == "package.json":
		return `{"version": "` + version + `"}`
	case name == "pyproject.toml":
		return "[project]\nversion = \"" + version + "\"\n"
	case name == "Cargo.toml":
		return "[package]\nversion = \"" + version + "\"\n"
	case strings.HasSuffix(name, ".gemspec"):
		return "require_relative \"lib/logbrew/version\"\n\nGem::Specification.new(\"logbrew-sdk\", LogBrew::VERSION) do |spec|\nend\n"
	case strings.HasSuffix(name, ".rb"):
		return "module LogBrew\n  VERSION = \"" + version + "\"\nend\n"
	case name == "pom.xml":
		return `<project xmlns="` + mavenNamespace + `"><version>` + version + "</version></project>"
	}
	return "<Project><PropertyGroup><Version>" + version + "</Version></PropertyGroup></Project>"
}

// versionFixture writes every repo-wide manifest with one version.
const rubyVersionFile = "ruby/logbrew-ruby/lib/logbrew/version.rb"

func versionFixture(t *testing.T, version string) string {
	t.Helper()
	root := t.TempDir()
	for _, entry := range mustCatalog().RepoWide {
		writeFixtureFile(t, root, entry[2], manifestText(entry[2], version))
	}
	writeFixtureFile(t, root, rubyVersionFile, manifestText(rubyVersionFile, version))
	return root
}

func TestReleaseVersionsRepositoryRustVersion(t *testing.T) {
	t.Parallel()
	var output, diagnostic bytes.Buffer
	if code := checkReleaseVersions([]string{"--rust", "../.."}, &output, &diagnostic); code != exitOK ||
		output.String() != mustCatalog().Rust+"\n" {
		t.Fatalf("code %d: %s%s", code, output.String(), diagnostic.String())
	}
}

// Every repo-wide manifest in this repository yields a version, including the
// gem, whose gemspec loads its version file.
func TestReleaseVersionsRepositoryManifests(t *testing.T) {
	t.Parallel()
	for _, entry := range mustCatalog().RepoWide {
		if version, err := readManifestVersion("../..", entry[2]); err != nil || version == "" ||
			entry[0] == "rubygems" && version != mustCatalog().RubyGems {
			t.Errorf("%s: %q, %v", entry[2], version, err)
		}
	}
}

func TestReleaseVersionsCommand(t *testing.T) {
	t.Parallel()
	aligned, mixed, broken := versionFixture(t, "1.2.3"), versionFixture(t, "1.2.3"), versionFixture(t, "1.2.3")
	writeFixtureFile(t, mixed, "js/logbrew-js/package.json", manifestText("package.json", "1.2.4"))
	writeFixtureFile(t, mixed, rustCrateManifest, manifestText("Cargo.toml", "1.2.4"))
	writeFixtureFile(t, mixed, rubyVersionFile, manifestText("version.rb", "1.2.4"))
	gemless, unversioned := versionFixture(t, "1.2.3"), versionFixture(t, "1.2.3")
	writeFixtureFile(t, gemless, rubyVersionFile, "module LogBrew\nend\n")
	writeFixtureFile(t, unversioned, "ruby/logbrew-ruby/logbrew-sdk.gemspec", "Gem::Specification.new(\"logbrew-sdk\")\n")
	writeFixtureFile(t, broken, "java/logbrew-java/pom.xml", "<project><version>1.2.3</version></project>")
	writeFixtureFile(t, broken, rustCrateManifest, "\xff")
	const usage = "usage: release-versions TAG [root] | release-versions --rust [root]\n"
	const failed = "repo-wide release version check failed: "
	for _, test := range []struct {
		output, diagnostic string
		arguments          []string
		code               int
	}{
		{"repo-wide release package versions ok for v1.2.3\n", "", []string{"v1.2.3", aligned}, exitOK},
		{"repo-wide release package versions ok for refs/tags/v1.2.3\n", "", []string{"refs/tags/v1.2.3", aligned}, exitOK},
		{"1.2.3\n", "", []string{"--rust", aligned}, exitOK},
		{"", "repo-wide release tag v1.2.3 expects every publishable package to be 1.2.3, but these manifests differ:\n" +
			"- npm @logbrew/sdk: 1.2.4 (js/logbrew-js/package.json)\n- crates logbrew: 1.2.4 (rust/logbrew/Cargo.toml)\n" +
			"- rubygems logbrew-sdk: 1.2.4 (ruby/logbrew-ruby/logbrew-sdk.gemspec)\n" +
			"Use scoped/manual changed-package publishing, or bump every listed package before creating the " +
			"repo-wide v1.2.3 GitHub Release.\n", []string{"v1.2.3", mixed}, exitFailure},
		{"", failed + "expected repo-wide release tag like v0.1.1, got 'go/logbrew/v1.2.3'\n",
			[]string{"go/logbrew/v1.2.3", aligned}, exitFailure},
		{"", failed + "rust/logbrew/Cargo.toml: invalid UTF-8\n", []string{"v1.2.3", broken}, exitFailure},
		{"", "rust/logbrew/Cargo.toml: invalid UTF-8\n", []string{"--rust", broken}, exitFailure},
		{"", failed + rubyVersionFile + ": could not read package version\n", []string{"v1.2.3", gemless}, exitFailure},
		{"", failed + "ruby/logbrew-ruby/logbrew-sdk.gemspec: could not read package version\n",
			[]string{"v1.2.3", unversioned}, exitFailure},
		{"", failed + "js/logbrew-js/package.json: open", []string{"v1.2.3", t.TempDir()}, exitFailure},
		{"", usage, nil, exitUsage},
		{"", usage, []string{"--unknown"}, exitUsage},
		{"", usage, []string{"v1.2.3", aligned, "extra"}, exitUsage},
		{"", usage, []string{"--rust", aligned, "extra"}, exitUsage},
	} {
		var output, diagnostic bytes.Buffer
		code := checkReleaseVersions(test.arguments, &output, &diagnostic)
		if code != test.code || output.String() != test.output || !strings.Contains(diagnostic.String(), test.diagnostic) {
			t.Errorf("%q: code %d, output %q, diagnostic %q", test.arguments, code, output.String(), diagnostic.String())
		}
	}
	mixedPom := versionFixture(t, "1.2.3")
	writeFixtureFile(t, mixedPom, "java/logbrew-java/pom.xml", "<project><version>1.2.3</version></project>")
	var output, diagnostic bytes.Buffer
	if code := checkReleaseVersions([]string{"v1.2.3", mixedPom}, &output, &diagnostic); code != exitFailure ||
		diagnostic.String() != failed+"java/logbrew-java/pom.xml: could not read package version\n" {
		t.Errorf("code %d: %q", code, diagnostic.String())
	}
}

//nolint:paralleltest // Swaps the embedded catalog.
func TestReleaseVersionsCatalogFailure(t *testing.T) {
	original := releaseCatalogText
	releaseCatalogText = "repo_wide = [[\"npm\"]]\n"
	defer func() { releaseCatalogText = original }()
	var output, diagnostic bytes.Buffer
	if code := checkReleaseVersions([]string{"v1.2.3"}, &output, &diagnostic); code != exitFailure ||
		diagnostic.String() != "repo-wide release version check failed: "+
			"each repo_wide entry needs an ecosystem, a package, and a manifest\n" {
		t.Fatalf("code %d: %s", code, diagnostic.String())
	}
}

func TestManifestVersion(t *testing.T) {
	t.Parallel()
	pom := `<project xmlns="` + mavenNamespace + `">`
	for _, test := range []struct {
		want       any
		name, text string
		failure    bool
	}{
		{"1.0.0", "package.json", `{"version": "1.0.0"}`, false},
		{nil, "package.json", `["1.0.0"]`, false},
		{nil, "package.json", `{"version": "1.0.0"} {}`, true},
		{"1.0.0", "pyproject.toml", "[project]\nversion = \"1.0.0\"\n[package]\nversion = \"2\"\n", false},
		{nil, "pyproject.toml", "project = \"1.0.0\"\n", false},
		{"1.0.0", "Cargo.toml", "[package]\nversion = \"1.0.0\"\n", false},
		{nil, "Cargo.toml", "[package\n", true},
		{"1.0.0", "a.gemspec", "do |spec|\n\tspec.version = \"1.0.0\"\n", false},
		{nil, "a.gemspec", "Gem::Specification.new(\"a\", A::VERSION) do |spec|\n", false},
		{"1.0.0", "version.rb", "module A\n  VERSION = '1.0.0'\nend\n", false},
		{nil, "version.rb", "module A\nend\n", false},
		{"2", "A.csproj", "<Project><PropertyGroup><Other/></PropertyGroup>" +
			"<PropertyGroup><Version>2</Version></PropertyGroup><PropertyGroup><Version>3</Version></PropertyGroup></Project>", false},
		{"", "A.csproj", "<Project><PropertyGroup><Version/></PropertyGroup>" +
			"<PropertyGroup><Version>3</Version></PropertyGroup></Project>", false},
		{nil, "A.csproj", `<Project xmlns="urn:x"><PropertyGroup><Version>1</Version></PropertyGroup></Project>`, false},
		{"1<", "pom.xml", pom + "<version>1&lt;<!-- c --><x/>2</version></project>", false},
		{nil, "pom.xml", pom + `<version xmlns="urn:x">1</version></project>`, false},
		{nil, "pom.xml", pom + "<version>1</version>", true},
		{nil, "README.md", "", true},
	} {
		value, err := manifestVersion(test.name, []byte(test.text))
		if value != test.want || (err != nil) != test.failure {
			t.Errorf("%s %q: got %#v, %v", test.name, test.text, value, err)
		}
	}
}

func TestParseXMLRejectsUnboundPrefixes(t *testing.T) {
	t.Parallel()
	for text, failure := range map[string]bool{
		`<a xmlns:p="urn:p"><p:b xml:lang="en" p:c="1"/></a>`: false,
		`<a><p:b/></a>`:                     true,
		`<a p:c="1"/>`:                      true,
		`<a><b xmlns:p="urn:p"/><p:b/></a>`: true,
	} {
		if _, err := parseXML([]byte(text)); (err != nil) != failure {
			t.Errorf("%s: %v", text, err)
		}
	}
	if (*xmlElement)(nil).findText("", "a") != nil {
		t.Error("missing element has text")
	}
}
