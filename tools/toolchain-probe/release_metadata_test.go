package main

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// releaseFixture copies every path the check requires from the repository
// into a fresh directory, so edits never touch the working tree.
func releaseFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for range 2 {
		for _, failure := range fixtureFailures(root) {
			relative, found := strings.CutPrefix(failure, "missing required path: ")
			if !found {
				relative, found = strings.CutPrefix(failure, "missing ")
			}
			if found {
				if err := copyRepositoryPath(root, relative); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	return root
}

func copyRepositoryPath(root, relative string) error {
	source := filepath.Join("..", "..", relative)
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	target := filepath.Join(root, relative)
	if info.IsDir() {
		return os.MkdirAll(target, 0o700)
	}
	data, err := os.ReadFile(source)
	if err == nil {
		err = os.MkdirAll(filepath.Dir(target), 0o700)
	}
	if err == nil {
		err = os.WriteFile(target, data, 0o600)
	}
	return err
}

func mustCatalog() releaseCatalog {
	catalog, err := loadReleaseCatalog(releaseCatalogText)
	if err != nil {
		panic(err)
	}
	return catalog
}

func fixtureFailures(root string) []string {
	check := &metadataCheck{root: root, catalog: mustCatalog()}
	check.all(nil, nil)
	return check.failures
}

func TestReleaseMetadataRepositoryPasses(t *testing.T) {
	t.Parallel()
	var output, diagnostic bytes.Buffer
	if code := checkReleaseMetadata([]string{"../.."}, &output, &diagnostic); code != exitOK ||
		output.String() != "release metadata ok\n" {
		t.Fatalf("code %d: %s%s", code, output.String(), diagnostic.String())
	}
	if failures := fixtureFailures(releaseFixture(t)); len(failures) > 0 {
		t.Fatalf("fixture failures: %q", failures)
	}
}

func replaceOnce(old, replacement string) func(string) string {
	return func(text string) string { return strings.Replace(text, old, replacement, 1) }
}

func replaceAll(old, replacement string) func(string) string {
	return func(text string) string { return strings.ReplaceAll(text, old, replacement) }
}

func appendText(extra string) func(string) string {
	return func(text string) string { return text + extra }
}

func TestReleaseMetadataFindings(t *testing.T) {
	t.Parallel()
	const (
		amqplib    = "js/logbrew-amqplib/package.json"
		sdkJS      = "js/logbrew-js/package.json"
		nextJS     = "js/logbrew-next/package.json"
		native     = "js/logbrew-react-native/package.json"
		flask      = "python/logbrew_flask/pyproject.toml"
		fastapi    = "python/logbrew_fastapi/pyproject.toml"
		hangfire   = "dotnet/logbrew-dotnet/src/LogBrew.Hangfire/LogBrew.Hangfire.csproj"
		httpClient = "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj"
		unity      = "unity/logbrew-unity/package.json"
		kotlin     = "kotlin/logbrew-kotlin/pom.xml"
		java       = "java/logbrew-java/pom.xml"
		gemspec    = "ruby/logbrew-ruby/logbrew-sdk.gemspec"
	)
	for _, test := range []struct {
		edit func(string) string // nil deletes the file
		path string
		want []string
	}{
		{nil, "LICENSE", []string{"missing required path: LICENSE", "LICENSE: expected MIT License text"}},
		{nil, "js/logbrew-vue/package.json", []string{
			"js: expected public package directories " + pyRepr(newPySet(mustCatalog().npmDirs()...)) + ", got " +
				pyRepr(newPySet(slices.DeleteFunc(mustCatalog().npmDirs(), func(dir string) bool {
					return dir == "js/logbrew-vue"
				})...)),
			"missing required path: js/logbrew-vue/package.json",
		}},
		{replaceOnce(`"version": "`, `"version": "1.0`), amqplib,
			[]string{amqplib + `: expected version to be a public semver, got '1.00.1.2'`}},
		{replaceOnce(`"type": "module",`, `"type": "module", "private": true, "module": "./x.js",`),
			amqplib, []string{
				amqplib + ": public SDK package must not be private",
				amqplib + ": expected module './index.js', got './x.js'",
			}},
		{replaceOnce(`"sideEffects": false`, `"sideEffects": 0`), amqplib,
			[]string{amqplib + ": expected sideEffects False, got 0"}},
		{replaceOnce(`"README.md",`, ""), amqplib, []string{amqplib + ": files must include 'README.md'"}},
		{replaceOnce(`".": {`, `"./unused": {`), amqplib, []string{amqplib + ": exports['.'] must be an object"}},
		{replaceOnce(`"default": "./index.cjs"`, `"default": "./index.js"`), amqplib,
			[]string{amqplib + ": expected exports['.'].require.default './index.cjs', got './index.js'"}},
		{replaceOnce(`">=0.10"`, `">=0.9"`), amqplib,
			[]string{amqplib + ": expected peerDependencies.amqplib '>=0.10', got '>=0.9'"}},
		{replaceOnce(`"@logbrew/sdk": "^`, `"@logbrew/sdk": "^9`), "js/logbrew-node/package.json", []string{
			"js/logbrew-node/package.json: peerDependencies.@logbrew/sdk must allow @logbrew/sdk ",
		}},
		{replaceOnce(`"./release-artifacts.js"`, `"./other.js"`), sdkJS,
			[]string{sdkJS + ": expected bin.logbrew-release-artifacts './release-artifacts.js', got './other.js'"}},
		{replaceOnce(`"./instrumentation": {`, `"./unused": {`), nextJS,
			[]string{nextJS + ": exports['./instrumentation'] must be an object"}},
		{replaceOnce(`">=49"`, `">=48"`), native, []string{native + ": expected peerDependencies.expo '>=49', got '>=48'"}},
		{replaceAll(`"react-native": {`, `"native": {`), native, []string{
			native + ": expected exports['./apple-native-diagnostics'].react-native.types " +
				"'./apple-native-diagnostics.d.ts', got None",
		}},
		{appendText("}"), amqplib, []string{"invalid JSON: "}},
		{func(string) string { return "[]" }, amqplib, []string{": expected a JSON object"}},
		{replaceOnce(`name = "logbrew"`, `name = "other"`), "rust/logbrew/Cargo.toml",
			[]string{"rust/logbrew/Cargo.toml: expected package.name 'logbrew', got 'other'"}},
		{appendText("["), "rust/logbrew/Cargo.toml", []string{"invalid TOML: "}},
		{replaceAll("Metrics", "Measures"), "rust/logbrew/README.md",
			[]string{"rust/logbrew/README.md: missing guidance Metrics"}},
		{nil, "rust/logbrew/Cargo.toml", []string{"missing required path: rust/logbrew/Cargo.toml"}},
		{nil, flask, []string{"missing required path: " + flask}},
		{replaceOnce("Flask>=3.1", "Flask>=3.0"), flask, []string{
			flask + ": expected project.dependencies {'Flask>=3.1', 'logbrew-sdk>=0.1.21,<0.2.0'}, " +
				"got {'Flask>=3.0', 'logbrew-sdk>=0.1.21,<0.2.0'}",
		}},
		{replaceOnce(`Repository = "https://github.com/LogBrewCo/sdk"`, `Repository = "https://example.com"`), flask,
			[]string{flask + ": expected project.urls.Repository 'https://github.com/LogBrewCo/sdk', got 'https://example.com'"}},
		{replaceOnce(`"LogBrew"`, `"Someone"`), flask, []string{flask + ": authors must include LogBrew"}},
		{replaceOnce("celery = [", "worker = ["), fastapi, []string{
			fastapi + ": expected project.optional-dependencies {'celery': {'logbrew-sdk[celery]>=0.1.27,<0.2.0'}}, " +
				"got {'worker': {'logbrew-sdk[celery]>=0.1.27,<0.2.0'}}",
		}},
		{nil, "python/logbrew_flask/src/logbrew_flask/py.typed",
			[]string{"missing required path: python/logbrew_flask/src/logbrew_flask/py.typed"}},
		{replaceOnce("go 1.26.0", "go 1.25.0"), "go/logbrew/go.mod", []string{"go/logbrew/go.mod: expected go 1.26.0"}},
		{replaceOnce("module github.com/LogBrewCo/sdk/go/logbrew", "module example.com/logbrew"), "go/logbrew/go.mod",
			[]string{"go/logbrew/go.mod: unexpected module path"}},
		{replaceOnce("github.com/gin-gonic/gin v1.12.0", "github.com/gin-gonic/gin v1.11.0"), "go/logbrew/gin/go.mod",
			[]string{"go/logbrew/gin/go.mod: expected framework requirement"}},
		{nil, "go/logbrew/otel/go.mod", []string{"missing required path: go/logbrew/otel/go.mod"}},
		{nil, "go/logbrew/go.mod", []string{"missing required path: go/logbrew/go.mod"}},
		{replaceOnce("logbrew_client_flush", "flush"), "c/logbrew-c/include/logbrew.h",
			[]string{"c/logbrew-c/include/logbrew.h: missing public C SDK symbol logbrew_client_flush"}},
		{nil, "c/logbrew-c/src/logbrew.c", []string{"missing required path: c/logbrew-c/src/logbrew.c"}},
		{replaceAll("class SdkException", "class Failure"), "cpp/logbrew-cpp/include/logbrew.hpp",
			[]string{"cpp/logbrew-cpp/include/logbrew.hpp: missing public C++ SDK symbol class SdkException"}},
		{replaceAll("open_telemetry_span_context", "span_context"), "cpp/logbrew-cpp/examples/trace_correlation.cpp",
			[]string{"cpp/logbrew-cpp/examples/trace_correlation.cpp: missing open_telemetry_span_context"}},
		{nil, "cpp/logbrew-cpp/include/logbrew.hpp", []string{"missing required path: cpp/logbrew-cpp/include/logbrew.hpp"}},
		{replaceOnce(`@"0.2.3"`, `@"0.2.4"`), "objc/logbrew-objc/src/LogBrew.m",
			[]string{"objc/logbrew-objc/src/LogBrew.m: Objective-C source version must be 0.2.3"}},
		{nil, "objc/logbrew-objc/include/LogBrew.h", []string{"missing required path: objc/logbrew-objc/include/LogBrew.h"}},
		{replaceAll("deliveryHealth", "health"), "objc/logbrew-objc/README.md",
			[]string{"objc/logbrew-objc/README.md: missing guidance deliveryHealth"}},
		{replaceOnce("<groupId>co.logbrew</groupId>", "<groupId>org.example</groupId>"), java,
			[]string{java + ": expected groupId 'co.logbrew', got 'org.example'"}},
		{replaceOnce("<maven.compiler.release>11</maven.compiler.release>", ""), java,
			[]string{java + ": expected properties.maven.compiler.release '11', got None"}},
		{replaceOnce("<artifactId>kotlin-stdlib</artifactId>", "<artifactId>kotlin-reflect</artifactId>"), kotlin,
			[]string{kotlin + ": dependencies must include org.jetbrains.kotlin:kotlin-stdlib"}},
		{appendText("<extra/>"), kotlin, []string{"invalid XML: junk after document element"}},
		{func(string) string { return "<?xml version=\"1.0\"?>" }, kotlin, []string{"invalid XML: no element found"}},
		{func(string) string { return "<project><name>" }, kotlin, []string{"invalid XML: "}},
		{replaceOnce("<Version>0.1.0</Version>", "<Version>0.2.0</Version>"), hangfire,
			[]string{hangfire + ": expected Version='0.1.0', found '0.2.0'"}},
		{replaceOnce("<Description>Public LogBrew", "<Description>Public"), hangfire,
			[]string{hangfire + ": expected Description to contain 'LogBrew'"}},
		{replaceOnce(`PackageReference Include="Hangfire.Core"`, `PackageReference Include="Other"`), hangfire,
			[]string{hangfire + `: package dependency metadata is missing PackageReference Include="Hangfire.Core"`}},
		{replaceOnce("<PackageId>LogBrew.Hangfire</PackageId>", "<PackageId></PackageId>"), hangfire, []string{
			"public package project must declare PackageId",
			"NuGet release catalog package is missing from source: LogBrew.Hangfire",
		}},
		{replaceOnce("<PackageId>LogBrew.Hangfire</PackageId>", "<PackageId>LogBrew.Jobs</PackageId>"), hangfire, []string{
			"NuGet release catalog package is missing from source: LogBrew.Hangfire",
			"NuGet release catalog is missing public package: LogBrew.Jobs",
		}},
		{replaceOnce("<PackageId>", "<IsPackable>false</IsPackable><PackageId>"), hangfire,
			[]string{"NuGet release catalog package is missing from source: LogBrew.Hangfire"}},
		{appendText("<extra/>"), hangfire, []string{"invalid XML: junk after document element"}},
		{replaceOnce("<SignAssembly>false</SignAssembly>", ""), httpClient,
			[]string{httpClient + ": expected SignAssembly='false', found None"}},
		{nil, "dotnet/logbrew-dotnet/examples/HangfireJobTelemetry.cs",
			[]string{"missing dotnet/logbrew-dotnet/examples/HangfireJobTelemetry.cs"}},
		{nil, "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj", []string{
			"missing dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj",
			"NuGet release catalog package is missing from source: LogBrew",
		}},
		{replaceOnce(`"version": "`, `"version": "9`), unity,
			[]string{unity + ": expected version '" + mustCatalog().Unity + "', got '9" + mustCatalog().Unity + "'"}},
		{replaceOnce("Samples~/ReadmeExample", "Samples~/Other"), unity, []string{
			unity + ": expected samples paths {'Samples~/ReadmeExample', 'Samples~/RealUserSmoke'}, " +
				"got {'Samples~/Other', 'Samples~/RealUserSmoke'}",
		}},
		{nil, unity, []string{"missing required path: " + unity}},
		{replaceOnce("createdAt: 1780778637391", "createdAt: soon"), openUPMUnityMetadata,
			[]string{openUPMUnityMetadata + ": createdAt must be a positive Unix timestamp in milliseconds"}},
		{replaceOnce("aliases: []", "aliases:\n  - 'unity'\n  bad"), openUPMUnityMetadata, []string{
			openUPMUnityMetadata + ": expected aliases [], got ['unity']",
			":4: unsupported YAML shape",
		}},
		{replaceOnce("parentRepoUrl: null", "parentRepoUrl: 7\n# note"), openUPMUnityMetadata,
			[]string{openUPMUnityMetadata + ": expected parentRepoUrl None, got 7"}},
		{replaceOnce("  - utilities\n", ""), openUPMUnityMetadata, []string{
			openUPMUnityMetadata + ": expected topics ['debugging-and-logging', 'integration', 'services', 'testing', " +
				"'utilities'], got ['debugging-and-logging', 'integration', 'services', 'testing']",
		}},
		{replaceOnce(`spec.license = "MIT"`, `spec.license = "Apache-2.0"`), gemspec,
			[]string{gemspec + ": missing license metadata"}},
		{replaceOnce("VERSION = ", "VERSION_NAME = "), "ruby/logbrew-ruby/lib/logbrew/version.rb",
			[]string{"ruby/logbrew-ruby/lib/logbrew/version.rb: version must match the gemspec"}},
		{replaceOnce("Rails Quick Start", "Rails"), "ruby/logbrew-ruby/README.md",
			[]string{"ruby/logbrew-ruby/README.md: missing guidance Rails Quick Start"}},
		{nil, gemspec, []string{"missing required path: " + gemspec}},
		{replaceOnce(`"src/"`, `"lib/"`), "php/logbrew-php/composer.json",
			[]string{`php/logbrew-php/composer.json: expected autoload.psr-4.LogBrew\ 'src/', got 'lib/'`}},
		{nil, "composer.json", []string{
			"missing required path: composer.json",
			"composer.json: expected support.issues 'https://github.com/LogBrewCo/sdk/issues', got None",
			"composer.json: keywords must include 'logbrew'",
		}},
		{replaceOnce(`path: "objc/logbrew-objc"`, `path: "objc"`), "Package.swift",
			[]string{`Package.swift: missing manifest entry path: "objc/logbrew-objc"`}},
		{nil, "swift/logbrew-swift/README.md", []string{"missing required path: swift/logbrew-swift/README.md"}},
	} {
		t.Run(test.path, func(t *testing.T) {
			t.Parallel()
			failures := editedFailures(t, test.path, test.edit)
			for _, want := range test.want {
				if !slices.ContainsFunc(failures, func(failure string) bool { return strings.Contains(failure, want) }) {
					t.Errorf("missing %q in %q", want, failures)
				}
			}
		})
	}
}

func (catalog releaseCatalog) npmDirs() []string {
	dirs := []string{}
	for _, entry := range catalog.NPM {
		dirs = append(dirs, entry[0])
	}
	return dirs
}

func editedFailures(t *testing.T, relative string, edit func(string) string) []string {
	t.Helper()
	root := releaseFixture(t)
	path := filepath.Join(root, relative)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if edit == nil {
		err = os.Remove(path)
	} else if edited := edit(string(data)); edited == string(data) {
		t.Fatal("the edit does not change " + relative)
	} else {
		err = os.WriteFile(path, []byte(edited), 0o600)
	}
	if err != nil {
		t.Fatal(err)
	}
	return fixtureFailures(root)
}

func TestReleaseWorkflowFindings(t *testing.T) {
	t.Parallel()
	const publishNuGet = publishNuGetWorkflow
	for _, test := range []struct {
		edit func(string) string
		path string
		want []string
	}{
		{nil, reconcilePublicWorkflow, []string{"missing required path: " + reconcilePublicWorkflow}},
		{replaceAll("workflow_dispatch:", "workflow_call:"), reconcilePublicWorkflow,
			[]string{reconcilePublicWorkflow + ": missing explicit dispatch"}},
		{appendText("\n# environment: release\n"), reconcilePublicWorkflow,
			[]string{reconcilePublicWorkflow + ": reconciliation cannot publish"}},
		{nil, publishReleaseWorkflow, []string{"missing required path: " + publishReleaseWorkflow}},
		{replaceAll("Check out release ref", "Check out"), publishReleaseWorkflow,
			[]string{publishReleaseWorkflow + ": missing release ref checkout"}},
		{replaceOnce("- name: Guard repo-wide release package versions",
			"echo ${{ inputs.maven_artifacts }} ${{ inputs.nuget_packages }}\n"+
				`          nuget_packages="$INPUT_NUGET_PACKAGES"`+"\n      - name: Guard repo-wide release package versions"),
			publishReleaseWorkflow, []string{
				publishReleaseWorkflow + ": Maven selector must not be interpolated into shell",
				publishReleaseWorkflow + ": NuGet selector must not be interpolated into shell",
				publishReleaseWorkflow + ": NuGet selector must be canonical before output",
			}},
		{nil, publishPackagesWorkflow, []string{"missing required path: " + publishPackagesWorkflow}},
		{replaceAll("id: verify-source", "id: source"), publishPackagesWorkflow,
			[]string{publishPackagesWorkflow + ": missing immutable verify source binding"}},
		{replaceAll("--skip-duplicate", "--force"), publishNuGet,
			[]string{publishPackagesWorkflow + ": missing NuGet duplicate-safe publish"}},
		{replaceAll("redis_version=", "cache_version="), publishNuGet,
			[]string{publishPackagesWorkflow + ": missing NuGet LogBrew.StackExchangeRedis version output"}},
		{replaceAll("js/logbrew-vue", "js/vue"), publishPackagesWorkflow,
			[]string{publishPackagesWorkflow + ": missing npm package dir js/logbrew-vue"}},
		{replaceAll("python/logbrew_flask", "python/flask"), publishPackagesWorkflow,
			[]string{publishPackagesWorkflow + ": missing PyPI package dir python/logbrew_flask"}},
		{replaceOnce("- name: Check selected Maven version collisions",
			"run: |\n          echo ${{ inputs.maven_artifacts }}\n      - name: Check selected Maven version collisions"),
			publishPackagesWorkflow, []string{publishPackagesWorkflow + ": Maven selector must not be interpolated into shell"}},
		{func(text string) string {
			text = replaceOnce("Upload Maven Central deployment bundle", "Upload bundle")(text)
			text = replaceOnce("id: maven-release-control", "id: control")(text)
			return replaceAll("https://central.sonatype.com/api/v1/publisher/upload", "https://example.com")(text)
		}, publishPackagesWorkflow, []string{
			publishPackagesWorkflow + ": Maven deployment status must complete before public verification",
			publishPackagesWorkflow + ": Maven upload must execute exactly once",
			publishPackagesWorkflow + ": Maven release-control script bytes must be rebound before both executions",
		}},
		{func(text string) string {
			maven, rest, _ := strings.Cut(after(text, "\n  maven:\n"), "\n  verify:\n")
			return before(text, "\n  maven:\n") + "\n  maven:\n" + strings.ReplaceAll(maven, checkoutDiscardsAuth, "") +
				"\n  verify:\n" + rest
		}, publishPackagesWorkflow,
			[]string{publishPackagesWorkflow + ": Maven release-control checkout must discard authentication state"}},
		{nil, "tools/npm-publish/publish.mjs", []string{"missing required path: tools/npm-publish/publish.mjs"}},
		{nil, publishNuGet, []string{
			"missing required path: " + publishNuGet,
			publishPackagesWorkflow + ": missing NuGet package version output",
		}},
		{replaceAll(checkoutDiscardsAuth, "persist-credentials: true"), publishNuGet, []string{
			publishNuGet + ": both checkouts must discard authentication state",
		}},
		{replaceAll(protectedRegistryCheck, `"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" registry-publication`), publishNuGet, []string{
			publishNuGet + ": missing protected registry checker execution",
			publishNuGet + ": both NuGet registry checks must use protected release control",
		}},
		{replaceAll("historical tags", "older tags"), "docs/github-actions.md",
			[]string{"docs/github-actions.md: missing release workflow safety warning"}},
		{nil, "docs/github-actions.md", []string{"missing required path: docs/github-actions.md"}},
		{replaceAll("@logbrew/vue", "vue"), ".github/publishing/trusted-publishers.md",
			[]string{".github/publishing/trusted-publishers.md: missing trusted publisher npm package @logbrew/vue"}},
		{replaceAll("logbrew-flask", "flask"), ".github/publishing/trusted-publishers.md",
			[]string{".github/publishing/trusted-publishers.md: missing trusted publisher PyPI package logbrew-flask"}},
	} {
		t.Run(test.path, func(t *testing.T) {
			t.Parallel()
			failures := editedFailures(t, test.path, test.edit)
			for _, want := range test.want {
				if !slices.Contains(failures, want) {
					t.Errorf("missing %q in %q", want, failures)
				}
			}
		})
	}
}

func TestReleaseMetadataCommand(t *testing.T) {
	t.Parallel()
	root := releaseFixture(t)
	if err := os.WriteFile(filepath.Join(root, "LICENSE"), []byte("Other\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	usage := "usage: release-metadata [--only-cpp] [--npm-version PACKAGE=VERSION]... " +
		"[--nuget-version PACKAGE=VERSION]... [root]\n"
	for _, test := range []struct {
		output, diagnostic  string
		arguments, findings []string
		code                int
	}{
		{"release metadata ok\n", "", []string{"--only-cpp", root}, nil, exitOK},
		{"", "LICENSE: expected MIT License text\n", []string{root}, nil, exitFailure},
		{"", "", []string{"--npm-version", "@logbrew/sdk=9.9.9", "--nuget-version", "LogBrew=9.9.9", root}, []string{
			"js/logbrew-js/package.json: expected version '9.9.9'",
			"LogBrew.csproj: expected Version='9.9.9'",
			"LogBrew.HttpClient.csproj: expected LogBrewCoreDependencyVersion='[9.9.9, 10.0.0)'",
		}, exitFailure},
		{"", usage, []string{"--unknown"}, nil, exitUsage},
		{"", usage, []string{"one", "two"}, nil, exitUsage},
		{"", usage + "release-metadata: expected package version in name=version form, got '@logbrew/sdk'\n",
			[]string{"--npm-version", "@logbrew/sdk"}, nil, exitUsage},
		{"", usage + "release-metadata: unknown package: LogBrew.Other\n",
			[]string{"--nuget-version", "LogBrew.Other=1.0.0"}, nil, exitUsage},
	} {
		var output, diagnostic bytes.Buffer
		code := checkReleaseMetadata(test.arguments, &output, &diagnostic)
		if code != test.code || output.String() != test.output || !strings.HasSuffix(diagnostic.String(), test.diagnostic) {
			t.Errorf("%q: code %d, output %q, diagnostic %q", test.arguments, code, output.String(), diagnostic.String())
		}
		for _, want := range test.findings {
			if !strings.Contains(diagnostic.String(), want) {
				t.Errorf("missing %q in %s", want, diagnostic.String())
			}
		}
	}
}

func TestReleaseCatalogErrors(t *testing.T) {
	t.Parallel()
	for _, text := range []string{"unknown = 1\n", "npm = [[\"js/logbrew-js\"]]\n", "repo_wide = [[\"npm\"]]\n", "rust = [\n"} {
		if _, err := loadReleaseCatalog(text); err == nil {
			t.Errorf("%q: catalog loaded", text)
		}
	}
}

//nolint:paralleltest // Swaps the embedded catalog.
func TestReleaseMetadataCatalogFailure(t *testing.T) {
	original := releaseCatalogText
	releaseCatalogText = "rust = 1\n"
	defer func() { releaseCatalogText = original }()
	var output, diagnostic bytes.Buffer
	if code := checkReleaseMetadata(nil, &output, &diagnostic); code != exitFailure ||
		!strings.HasPrefix(diagnostic.String(), "release catalog is invalid: ") {
		t.Fatalf("code %d: %s", code, diagnostic.String())
	}
}

func TestReleaseMetadataHelpers(t *testing.T) {
	t.Parallel()
	for value, want := range map[string]string{
		"0.1.11": "[0.1.11, 0.2.0)", "1.2.3": "[1.2.3, 2.0.0)", "1": "", "x.1.0": "", "1.x.0": "",
	} {
		if got := compatibleDependencyRange(value); got != want {
			t.Errorf("%q: got %q, want %q", value, got, want)
		}
	}
	for _, test := range []struct {
		value any
		want  string
	}{
		{nil, "None"}, {true, "True"}, {"it's", `"it's"`}, {`a'b"c\` + "\n\r\t\x01", `'a\'b"c\\\n\r\t\x01'`},
		{pySet{}, "set()"}, {[]any{"a", int64(1)}, "['a', 1]"},
		{map[string]any{"b": nil, "a": []string{}}, "{'a': [], 'b': None}"},
	} {
		if got := pyRepr(test.value); got != test.want {
			t.Errorf("%v: got %s, want %s", test.value, got, test.want)
		}
	}
	values := versionFlags{"a=1"}
	if values.String() != "a=1" || values.Set("b=2") != nil || values.String() != "a=1,b=2" {
		t.Errorf("version flags %q", values)
	}
	root := t.TempDir()
	writeFixtureFile(t, root, "trailing.json", "{} {}")
	check := &metadataCheck{root: root}
	if check.readJSON("trailing.json"); len(check.failures) != 1 ||
		!strings.HasSuffix(check.failures[0], "invalid JSON: extra data after the JSON value") {
		t.Errorf("failures %q", check.failures)
	}
	if element, err := parseXML([]byte("<a>x<!-- note -->y<b/>z</a>")); err != nil || element.rawText("b") != nil ||
		*element.value != "xy" {
		t.Errorf("parsed %v, %v", element, err)
	}
	if element := (*xmlElement)(nil); element.text("a") != nil || element.all("a") != nil {
		t.Error("missing element has text or children")
	}
}

func TestReleaseMetadataNuGetProjectPath(t *testing.T) {
	t.Parallel()
	root := releaseFixture(t)
	project := filepath.Join(root, "dotnet/logbrew-dotnet/src/LogBrew.Hangfire")
	if err := os.Rename(filepath.Join(project, "LogBrew.Hangfire.csproj"), filepath.Join(project, "Hangfire.csproj")); err != nil {
		t.Fatal(err)
	}
	want := "NuGet release catalog path mismatch for LogBrew.Hangfire: expected " +
		"dotnet/logbrew-dotnet/src/LogBrew.Hangfire/LogBrew.Hangfire.csproj, found " +
		"dotnet/logbrew-dotnet/src/LogBrew.Hangfire/Hangfire.csproj"
	if failures := fixtureFailures(root); !slices.Contains(failures, want) {
		t.Fatalf("missing %q in %q", want, failures)
	}
}
