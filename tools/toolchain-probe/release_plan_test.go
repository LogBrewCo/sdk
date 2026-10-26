package main

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func pomText(artifact, version string, dependencies ...string) string {
	text := `<project xmlns="http://maven.apache.org/POM/4.0.0"><groupId>co.logbrew</groupId><artifactId>` +
		artifact + "</artifactId><version>" + version + "</version><dependencies>" +
		"<dependency><groupId>org.example</groupId></dependency>"
	for _, dependency := range dependencies {
		text += dependency
	}
	return text + "</dependencies></project>"
}

func dependencyText(artifact, version string) string {
	return "<dependency><groupId>co.logbrew</groupId><artifactId>" + artifact + "</artifactId><version>" +
		version + "</version></dependency>"
}

// planFixture writes every Maven POM and NuGet project the catalog names.
func planFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFixtureFile(t, root, "java/logbrew-java/pom.xml", pomText("logbrew-sdk", "0.1.13"))
	writeFixtureFile(t, root, "kotlin/logbrew-kotlin/pom.xml", pomText("logbrew-kotlin", "0.2.3"))
	writeFixtureFile(t, root, "kotlin/logbrew-kotlin-okhttp/pom.xml",
		pomText("logbrew-kotlin-okhttp", "0.2.3", dependencyText("logbrew-kotlin", "0.2.3")))
	for _, release := range mustCatalog().NuGet {
		writeFixtureFile(t, root, release.project(),
			"<Project><PropertyGroup><Version> "+release.Version+"\n</Version></PropertyGroup></Project>")
	}
	return root
}

func runPlan(environment map[string]string, arguments ...string) (int, string, string) {
	var output, diagnostic bytes.Buffer
	lookup := func(name string) (string, bool) {
		value, found := environment[name]
		return value, found
	}
	code := checkReleasePlan(arguments, lookup, &output, &diagnostic)
	return code, output.String(), diagnostic.String()
}

type planCase struct {
	environment        map[string]string
	output, diagnostic string
	arguments          []string
	code               int
}

func checkPlanCases(t *testing.T, cases []planCase) {
	t.Helper()
	for _, test := range cases {
		code, output, diagnostic := runPlan(test.environment, test.arguments...)
		if code != test.code || output != test.output || diagnostic != test.diagnostic {
			t.Errorf("%q: code %d, output %q, diagnostic %q", test.arguments, code, output, diagnostic)
		}
	}
}

func readText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

const okhttpPlan = `{
  "externalDependencies": [
    {
      "artifactId": "logbrew-kotlin",
      "coordinate": "co.logbrew:logbrew-kotlin",
      "version": "0.2.3"
    }
  ],
  "schemaVersion": 1,
  "selected": [
    {
      "artifactId": "logbrew-kotlin-okhttp",
      "coordinate": "co.logbrew:logbrew-kotlin-okhttp",
      "packageDir": "kotlin/logbrew-kotlin-okhttp",
      "version": "0.2.3"
    }
  ]
}
`

func TestReleasePlanRepository(t *testing.T) {
	t.Parallel()
	plan := filepath.Join(t.TempDir(), "nested", "plan.json")
	checkPlanCases(t, []planCase{
		{nil, "logbrew-sdk,logbrew-kotlin,logbrew-kotlin-okhttp\n", "",
			[]string{"maven", "canonicalize", "--root", "../..", "--artifacts", ""}, exitOK},
		{map[string]string{"P": ""}, "nuget release plan ok\n", "",
			[]string{"nuget", "create", "--root", "../..", "--packages-env", "P", "--output", plan}, exitOK},
		{nil, "nuget release plan ok\n", "", []string{"nuget", "validate", "--root", "../..", "--plan", plan}, exitOK},
	})
}

func TestReleasePlanMavenCreate(t *testing.T) {
	t.Parallel()
	root := planFixture(t)
	plan := filepath.Join(t.TempDir(), "plan.json")
	environment := map[string]string{"A": " logbrew-kotlin-okhttp\x1f"}
	for _, arguments := range [][]string{
		{"--artifact", "logbrew-kotlin-okhttp"},
		{"--artifacts", "logbrew-kotlin-okhttp"},
		{"--artifacts-env", "A"},
	} {
		arguments = append([]string{"maven", "create", "--root", root, "--output", plan}, arguments...)
		if code, output, diagnostic := runPlan(environment, arguments...); code != exitOK || output != "" ||
			diagnostic != "" || readText(t, plan) != okhttpPlan {
			t.Errorf("%q: code %d %q %q %q", arguments, code, output, diagnostic, readText(t, plan))
		}
	}
	checkPlanCases(t, []planCase{
		{nil, "logbrew-sdk,logbrew-kotlin-okhttp\n", "",
			[]string{"maven", "canonicalize", "--root", root, "--artifacts", "logbrew-kotlin-okhttp, logbrew-sdk"}, exitOK},
		{nil, "logbrew-sdk,logbrew-kotlin,logbrew-kotlin-okhttp\n", "",
			[]string{"maven", "canonicalize", "--root", root, "--artifacts-env", "MISSING"}, exitOK},
		{nil, "", "Maven release plan failed: invalid Maven artifact selection\n",
			[]string{"maven", "canonicalize", "--root", root, "--artifacts", "logbrew-sdk,"}, exitFailure},
		{nil, "", "Maven release plan failed: invalid Maven artifact selection\n",
			[]string{"maven", "canonicalize", "--root", root, "--artifacts", "logbrew-sdk\r"}, exitFailure},
		{nil, "", "Maven release plan failed: duplicate Maven artifact selection\n",
			[]string{"maven", "create", "--root", root, "--artifact", "logbrew-sdk", "--artifact", "logbrew-sdk",
				"--output", plan}, exitFailure},
		{nil, "", "Maven release plan failed: unsupported Maven artifact selection\n",
			[]string{"maven", "create", "--root", root, "--artifact", "", "--output", plan}, exitFailure},
	})
	if code, _, diagnostic := runPlan(nil, "maven", "create", "--root", root, "--artifacts", "", "--output",
		filepath.Join(plan, "plan.json")); code != exitFailure || !strings.HasPrefix(diagnostic, "Maven release plan failed: ") {
		t.Errorf("unwritable output: code %d, %q", code, diagnostic)
	}
}

func TestReleasePlanMavenMetadata(t *testing.T) {
	t.Parallel()
	const okhttp = "kotlin/logbrew-kotlin-okhttp/pom.xml"
	const failed = "Maven release plan failed: "
	for _, test := range []struct {
		location, content, diagnostic string
	}{
		{okhttp, "<project>", failed + "invalid Maven metadata for logbrew-kotlin-okhttp: ParseError"},
		{okhttp, "\xff", failed + "invalid Maven metadata for logbrew-kotlin-okhttp: UnicodeDecodeError"},
		{"kotlin/logbrew-kotlin/pom.xml", "<project/>", failed + "missing groupId in logbrew-kotlin"},
		{okhttp, "<project><groupId>co.logbrew</groupId></project>", failed + "missing artifactId in logbrew-kotlin-okhttp"},
		{okhttp, "<project><groupId>co.logbrew</groupId><artifactId>logbrew-kotlin-okhttp</artifactId><version> " +
			"</version></project>", failed + "missing version in logbrew-kotlin-okhttp"},
		{okhttp, pomText("other", "0.2.3"), failed + "unexpected Maven coordinate in kotlin/logbrew-kotlin-okhttp/pom.xml"},
		{okhttp, pomText("logbrew-kotlin-okhttp", "0.2"), failed + "invalid Maven version for logbrew-kotlin-okhttp"},
		{okhttp, pomText("logbrew-kotlin-okhttp", "0.2.3"),
			failed + "unexpected internal Maven dependency closure in logbrew-kotlin-okhttp"},
		{okhttp, pomText("logbrew-kotlin-okhttp", "0.2.3", "<dependency/>"), failed + "missing groupId in logbrew-kotlin-okhttp"},
		{okhttp, pomText("logbrew-kotlin-okhttp", "0.2.3", "<dependency><groupId>co.logbrew</groupId></dependency>"),
			failed + "missing artifactId in logbrew-kotlin-okhttp"},
		{okhttp, pomText("logbrew-kotlin-okhttp", "0.2.3", "<dependency><groupId>co.logbrew</groupId>"+
			"<artifactId>logbrew-kotlin</artifactId></dependency>"), failed + "missing version in logbrew-kotlin-okhttp"},
		{okhttp, pomText("logbrew-kotlin-okhttp", "0.2.3", dependencyText("other", "1.0.0")),
			failed + "unsupported internal Maven dependency in logbrew-kotlin-okhttp"},
		{okhttp, pomText("logbrew-kotlin-okhttp", "0.2.3", dependencyText("logbrew-kotlin", "0.2.3"),
			dependencyText("logbrew-kotlin", "0.2.3")), failed + "duplicate internal Maven dependency in logbrew-kotlin-okhttp"},
		{okhttp, pomText("logbrew-kotlin-okhttp", "0.2.3", dependencyText("logbrew-kotlin", "x")),
			failed + "invalid internal Maven dependency version in logbrew-kotlin-okhttp"},
		{okhttp, pomText("logbrew-kotlin-okhttp", "0.2.3", dependencyText("logbrew-kotlin", "0.2.4")),
			failed + "dependency version mismatch for logbrew-kotlin-okhttp"},
		{"kotlin/logbrew-kotlin/pom.xml", "<", failed + "invalid Maven metadata for logbrew-kotlin: ParseError"},
	} {
		root := planFixture(t)
		writeFixtureFile(t, root, test.location, test.content)
		code, output, diagnostic := runPlan(nil, "maven", "canonicalize", "--root", root, "--artifacts", "logbrew-kotlin-okhttp")
		if code != exitFailure || output != "" || diagnostic != test.diagnostic+"\n" {
			t.Errorf("%s: code %d, %q", test.content, code, diagnostic)
		}
	}
}

func TestReleasePlanMavenValidate(t *testing.T) {
	t.Parallel()
	root := planFixture(t)
	directory := t.TempDir()
	plan := filepath.Join(directory, "plan.json")
	if code, _, diagnostic := runPlan(nil, "maven", "create", "--root", root, "--artifacts", "", "--output", plan); code != exitOK {
		t.Fatal(diagnostic)
	}
	saved := map[string]string{
		"same.json":     strings.Replace(readText(t, plan), `"schemaVersion": 1`, `"schemaVersion": true`, 1),
		"changed.json":  strings.Replace(readText(t, plan), "0.1.13", "0.1.14", 1),
		"array.json":    "[]",
		"broken.json":   "{",
		"trailing.json": "{} {}",
		"invalid.json":  "\xff",
		"empty.json":    `{"selected": []}`,
		"loose.json":    `{"selected": [1]}`,
	}
	for name, content := range saved {
		writeFixtureFile(t, directory, name, content)
	}
	const failed = "Maven release plan failed: "
	validate := func(name string) []string {
		return []string{"maven", "validate", "--root", root, "--plan", filepath.Join(directory, name)}
	}
	checkPlanCases(t, []planCase{
		{nil, "", "", validate("plan.json"), exitOK},
		{nil, "", "", validate("same.json"), exitOK},
		{nil, "", failed + "saved release plan does not match current Maven metadata\n", validate("changed.json"), exitFailure},
		{nil, "", failed + "invalid Maven release plan\n", validate("array.json"), exitFailure},
		{nil, "", failed + "invalid Maven release plan: JSONDecodeError\n", validate("broken.json"), exitFailure},
		{nil, "", failed + "invalid Maven release plan: JSONDecodeError\n", validate("trailing.json"), exitFailure},
		{nil, "", failed + "invalid Maven release plan: UnicodeDecodeError\n", validate("invalid.json"), exitFailure},
		{nil, "", failed + "invalid Maven release plan: FileNotFoundError\n", validate("absent.json"), exitFailure},
		{nil, "", failed + "select at least one Maven artifact\n", validate("empty.json"), exitFailure},
		{nil, "", failed + "invalid Maven release plan\n", validate("loose.json"), exitFailure},
	})
}

func TestReleasePlanMavenManifest(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	stage, bundle := filepath.Join(directory, "stage"), filepath.Join(directory, "bundle.zip")
	base := filepath.Join(stage, "co", "logbrew", "logbrew-sdk", "1.0.0")
	for _, name := range []string{"a-b/x.pom", "a/x.pom", "\u00e9.jar"} {
		writeFixtureFile(t, base, name, "x")
	}
	writeFixtureFile(t, directory, "bundle.zip", "bundle")
	writeFixtureFile(t, filepath.Join(stage, "co", "logbrew", "logbrew-kotlin", "1.0.0"), "locked.jar", "x")
	if err := os.Chmod(filepath.Join(stage, "co", "logbrew", "logbrew-kotlin", "1.0.0", "locked.jar"), 0); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"plan.json": `{"selected": [{"artifactId": "logbrew-sdk", "version": "1.0.0", "n": [-0, 1.0, 1E16, 2e-5, 7]}],` +
			` "externalDependencies": null}`,
		"default.json":  `{}`,
		"loose.json":    `{"selected": {}}`,
		"entry.json":    `{"selected": [{"artifactId": "logbrew-sdk"}]}`,
		"missing.json":  `{"selected": [{"artifactId": "logbrew-other", "version": "1.0.0"}]}`,
		"locked.json":   `{"selected": [{"artifactId": "logbrew-kotlin", "version": "1.0.0"}]}`,
		"infinite.json": `{"selected": [], "externalDependencies": [1e400]}`,
	} {
		writeFixtureFile(t, directory, name, content)
	}
	manifest := filepath.Join(directory, "manifest.json")
	commit := strings.Repeat("a", 40)
	arguments := func(plan, bundle, commit string) []string {
		return []string{"maven", "manifest", "--plan", filepath.Join(directory, plan), "--stage", stage,
			"--bundle", bundle, "--source-commit", commit, "--output", manifest}
	}
	const failed = "Maven release plan failed: "
	checkPlanCases(t, []planCase{
		{nil, "", "", arguments("plan.json", bundle, commit), exitOK},
	})
	const want = `{
  "artifacts": [
    {
      "artifactId": "logbrew-sdk",
      "files": [
        {
          "path": "co/logbrew/logbrew-sdk/1.0.0/a/x.pom",
          "sha256": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
        },
        {
          "path": "co/logbrew/logbrew-sdk/1.0.0/a-b/x.pom",
          "sha256": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
        },
        {
          "path": "co/logbrew/logbrew-sdk/1.0.0/\u00e9.jar",
          "sha256": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
        }
      ],
      "n": [
        0,
        1.0,
        1e+16,
        2e-05,
        7
      ],
      "version": "1.0.0"
    }
  ],
  "bundle": {
    "sha256": "4f2b6f5b5b4a4ee1c9d7e7c4e9f5b4f6e0a3b9b7e7e3a1f0b5f0c1d3b5e6f7a8"
  },
  "externalDependencies": null,
  "schemaVersion": 1,
  "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
`
	digest, _ := fileSHA256(bundle)
	if got := readText(t, manifest); got != strings.Replace(want,
		"4f2b6f5b5b4a4ee1c9d7e7c4e9f5b4f6e0a3b9b7e7e3a1f0b5f0c1d3b5e6f7a8", digest, 1) {
		t.Errorf("manifest:\n%s", got)
	}
	checkPlanCases(t, []planCase{
		{nil, "", "", arguments("default.json", bundle, commit), exitOK},
		{nil, "", failed + "source commit must be 40 lowercase hexadecimal characters\n",
			arguments("plan.json", bundle, strings.Repeat("A", 40)), exitFailure},
		{nil, "", failed + "release bundle is missing\n", arguments("plan.json", stage, commit), exitFailure},
		{nil, "", failed + "invalid Maven release plan\n", arguments("loose.json", bundle, commit), exitFailure},
		{nil, "", failed + "invalid Maven release plan\n", arguments("entry.json", bundle, commit), exitFailure},
		{nil, "", failed + "selected Maven artifact files are missing for logbrew-other\n",
			arguments("missing.json", bundle, commit), exitFailure},
		{nil, "", failed + "float out of range\n", arguments("infinite.json", bundle, commit), exitFailure},
		{nil, "", failed + "invalid Maven release plan: FileNotFoundError\n", arguments("absent.json", bundle, commit),
			exitFailure},
	})
	if os.Geteuid() != 0 {
		code, _, diagnostic := runPlan(nil, arguments("locked.json", bundle, commit)...)
		if code != exitFailure || !strings.Contains(diagnostic, "permission denied") {
			t.Errorf("locked: code %d, %q", code, diagnostic)
		}
	}
	if !strings.Contains(readText(t, manifest), "\"artifacts\": []") {
		t.Error("default manifest lacks empty artifacts")
	}
}

func TestReleasePlanNuGet(t *testing.T) {
	t.Parallel()
	root := planFixture(t)
	directory := t.TempDir()
	plan := filepath.Join(directory, "plan.json")
	create := []string{"nuget", "create", "--root", root, "--packages-env", "P", "--output", plan}
	checkPlanCases(t, []planCase{
		{map[string]string{"P": " LogBrew.Hangfire\x1c"}, "nuget release plan ok\n", "", create, exitOK},
	})
	const hangfire = `{"schemaVersion":1,"selected":[{"packageId":"LogBrew.Hangfire","projectPath":` +
		`"dotnet/logbrew-dotnet/src/LogBrew.Hangfire/LogBrew.Hangfire.csproj","version":"0.1.0",` +
		`"versionOutput":"hangfire_version"}],"selectionMode":"selected"}` + "\n"
	if readText(t, plan) != hangfire {
		t.Errorf("plan: %s", readText(t, plan))
	}
	core := filepath.Join(directory, "core.json")
	checkPlanCases(t, []planCase{
		{map[string]string{"P": "LogBrew.HttpClient,LogBrew"}, "nuget release plan ok\n", "",
			[]string{"nuget", "create", "--root", root, "--packages-env", "P", "--output", core}, exitOK},
	})
	saved := map[string]string{
		"float.json": strings.Replace(readText(t, core), `"schemaVersion":1`, `"schemaVersion":1.0`, 1),
		"extra.json": strings.Replace(readText(t, core), `"schemaVersion":1`, `"schemaVersion":1,"x":1`, 1),
		"all.json":   strings.Replace(readText(t, core), `"selected"}`, `"all"}`, 1),
		"pair.json":  strings.Replace(readText(t, plan), `LogBrew.Hangfire"`, `LogBrew"`, 1),
		"reversed.json": `{"schemaVersion":1,"selectionMode":"selected","selected":[{"packageId":"LogBrew.HttpClient"},` +
			`{"packageId":"LogBrew"}]}`,
		"empty.json": `{"schemaVersion":1,"selectionMode":"selected","selected":[]}`,
		"mode.json":  `{"schemaVersion":1,"selectionMode":"other","selected":[{"packageId":"LogBrew.Hangfire"}]}`,
		"array.json": "[]",
	}
	for name, content := range saved {
		writeFixtureFile(t, directory, name, content)
	}
	entries := func(name, format string) []string {
		return []string{"nuget", "entries", "--root", root, "--plan", filepath.Join(directory, name), "--format", format}
	}
	validate := func(name string) []string {
		return []string{"nuget", "validate", "--root", root, "--plan", filepath.Join(directory, name)}
	}
	selection := func(value string) map[string]string { return map[string]string{"P": value} }
	const invalidSelection, invalidPlan = "invalid NuGet package selection\n", "invalid NuGet release plan\n"
	checkPlanCases(t, []planCase{
		{nil, "nuget release plan ok\n", "", validate("plan.json"), exitOK},
		{nil, "nuget release plan ok\n", "", validate("float.json"), exitOK},
		{nil, "LogBrew.Hangfire\n", "", entries("plan.json", "ids"), exitOK},
		{nil, "LogBrew=0.1.12\nLogBrew.HttpClient=0.1.7\n", "", entries("core.json", "versions"), exitOK},
		{nil, "LogBrew\tdotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj\t0.1.12\nLogBrew.HttpClient\t" +
			"dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj\t0.1.7\n", "",
			entries("core.json", "projects"), exitOK},
		{nil, "selected\n", "", entries("core.json", "mode"), exitOK},
		{nil, "", invalidPlan, validate("extra.json"), exitFailure},
		{nil, "", invalidPlan, validate("all.json"), exitFailure},
		{nil, "", invalidPlan, validate("pair.json"), exitFailure},
		{nil, "", invalidPlan, validate("reversed.json"), exitFailure},
		{nil, "", invalidPlan, validate("empty.json"), exitFailure},
		{nil, "", invalidPlan, validate("mode.json"), exitFailure},
		{nil, "", invalidPlan, validate("array.json"), exitFailure},
		{nil, "", invalidPlan, validate("absent.json"), exitFailure},
		{nil, "", invalidSelection, create, exitFailure},
		{selection("LogBrew"), "", invalidSelection, create, exitFailure},
		{selection("LogBrew.Hangfire,LogBrew.AspNetCore"), "", invalidSelection, create, exitFailure},
		{selection("LogBrew,LogBrew"), "", invalidSelection, create, exitFailure},
		{selection("LogBrew,"), "", invalidSelection, create, exitFailure},
		{selection("LogBrew.Other"), "", invalidSelection, create, exitFailure},
		{selection("LogBrew.Hangfire\n"), "", invalidSelection, create, exitFailure},
		{selection("LogBrew.Hangfire"), "", invalidSelection,
			[]string{"nuget", "create", "--root", root, "--packages-env", "P", "--output", root}, exitFailure},
		{selection(""), "\n", "", []string{"nuget", "canonicalize", "--packages-env", "P"}, exitOK},
		{selection("LogBrew.HttpClient, LogBrew"), "LogBrew,LogBrew.HttpClient\n", "",
			[]string{"nuget", "canonicalize", "--packages-env", "P"}, exitOK},
		{selection("LogBrew"), "", invalidPlan, []string{"nuget", "canonicalize", "--packages-env", "P"}, exitFailure},
	})
	for _, content := range []string{"<Project>", "\xff<Project/>", "<Project><PropertyGroup><Version>1.0</Version>" +
		"</PropertyGroup></Project>", "<Project/>"} {
		writeFixtureFile(t, root, "dotnet/logbrew-dotnet/src/LogBrew.Hangfire/LogBrew.Hangfire.csproj", content)
		checkPlanCases(t, []planCase{
			{selection("LogBrew.Hangfire"), "", invalidSelection, create, exitFailure},
			{nil, "", invalidPlan, validate("plan.json"), exitFailure},
		})
	}
	checkPlanCases(t, []planCase{
		{selection(""), "", invalidSelection, create, exitFailure},
	})
}

func TestReleasePlanUsage(t *testing.T) {
	t.Parallel()
	for _, arguments := range [][]string{
		nil, {"maven"}, {"maven", "other"}, {"gradle", "create"}, {"maven", "validate", "--root", "."},
		{"maven", "validate", "--root", ".", "--plan", "p", "extra"},
		{"maven", "validate", "--root", ".", "--plan", "p", "--output", "o"},
		{"maven", "create", "--root", ".", "--output", "o", "--artifacts", "a", "--artifacts-env", "A"},
		{"maven", "canonicalize", "--root", ".", "--artifact", "a"},
		{"nuget", "entries", "--root", ".", "--plan", "p", "--format", "json"},
		{"nuget", "canonicalize", "--unknown"},
	} {
		if code, output, diagnostic := runPlan(nil, arguments...); code != exitUsage || output != "" ||
			diagnostic != releasePlanUsage {
			t.Errorf("%q: code %d %q %q", arguments, code, output, diagnostic)
		}
	}
}

//nolint:paralleltest // Swaps the embedded catalog.
func TestReleasePlanCatalogFailure(t *testing.T) {
	original := releaseCatalogText
	releaseCatalogText = "maven_artifacts = [[\"logbrew-sdk\"]]\n"
	defer func() { releaseCatalogText = original }()
	checkPlanCases(t, []planCase{
		{nil, "", "Maven release plan failed: each maven_artifacts entry needs an artifact and a directory\n",
			[]string{"maven", "validate", "--root", ".", "--plan", "p"}, exitFailure},
		{nil, "", "invalid NuGet release plan\n", []string{"nuget", "validate", "--root", ".", "--plan", "p"}, exitFailure},
	})
}

func TestReleasePlanHelpers(t *testing.T) {
	t.Parallel()
	loop := filepath.Join(t.TempDir(), "loop")
	if err := os.Symlink(loop, loop); err != nil {
		t.Fatal(err)
	}
	_, loopError := os.ReadFile(loop)
	for err, want := range map[error]string{
		fs.ErrNotExist: "FileNotFoundError", fs.ErrPermission: "PermissionError", syscall.EISDIR: "IsADirectoryError",
		syscall.ENOTDIR: "NotADirectoryError", loopError: "OSError", errJSONDecode: "JSONDecodeError",
	} {
		if got := pyErrorName(err); got != want {
			t.Errorf("%v: %s", err, got)
		}
	}
	for left, right := range map[any]any{"a": json.Number("1"), json.Number("2"): true} {
		if pyEqual(left, right) {
			t.Errorf("%v == %v", left, right)
		}
	}
	for _, values := range [][2]any{
		{map[string]any{"a": true}, map[string]any{"a": json.Number("1.0")}},
		{[]any{false, nil, "x"}, []any{json.Number("0"), nil, "x"}},
	} {
		if !pyEqual(values[0], values[1]) {
			t.Errorf("%v != %v", values[0], values[1])
		}
	}
	for _, values := range [][2]any{
		{map[string]any{"a": true}, map[string]any{}}, {map[string]any{"a": true}, map[string]any{"b": true}},
		{map[string]any{}, []any{}}, {[]any{}, map[string]any{}},
	} {
		if pyEqual(values[0], values[1]) {
			t.Errorf("%v == %v", values[0], values[1])
		}
	}
	directory := t.TempDir()
	writeFixtureFile(t, directory, "file", "")
	for path, value := range map[string]any{
		filepath.Join(directory, "file", "plan.json"): map[string]any{},
		filepath.Join(directory, "plan.json"):         map[string]any{"a": []any{json.Number("1e999")}},
		filepath.Join(directory, "list.json"):         []any{map[string]any{"a": json.Number("1e999")}},
	} {
		if writePlanJSON(path, value, "") == nil {
			t.Errorf("%s: written", path)
		}
	}
	text := filepath.Join(directory, "text.json")
	if err := writePlanJSON(text, []any{"\u00e9\U0001f600\x7f<&>"}, ""); err != nil ||
		readText(t, text) != `["\u00e9\ud83d\ude00\u007f<&>"]`+"\n" {
		t.Errorf("%v: %s", err, readText(t, text))
	}
	if element, err := parseXML([]byte("\ufeff<?xml version=\"1.0\" encoding=\"latin1\"?><a>1</a>")); err != nil ||
		*element.value != "1" {
		t.Errorf("declaration after BOM: %v", err)
	}
	if _, err := parseXML([]byte("<?xml version=\"1.0\"?><?xml version=\"1.0\"?><a/>")); err == nil {
		t.Error("second declaration accepted")
	}
	if pyStrip("\x1c\u00a0a \x1f") != "a" {
		t.Error("pyStrip")
	}
}
