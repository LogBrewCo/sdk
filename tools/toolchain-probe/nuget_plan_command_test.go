package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	nugetFixtureSuccess    = "nuget release plan ok\n"
	nugetCreateMode        = "create"
	nugetFixtureFormatFlag = "--format"
	nugetFixtureOutputFlag = "--output"
	nugetEntriesMode       = "entries"
)

func assertNugetCommand(t *testing.T, arguments []string, code int, expected string) {
	t.Helper()
	var output, diagnostic bytes.Buffer
	if actual := runNugetPlan(arguments, &output, &diagnostic); actual != code || output.String() != expected {
		t.Fatalf("NuGet command returned code %d, expected %d, or incorrect output", actual, code)
	}
	if (code == exitOK) != (diagnostic.Len() == 0) {
		t.Fatal("NuGet command diagnostic contradicts its exit status")
	}
}

func TestNugetPlanInvalidArguments(t *testing.T) {
	t.Parallel()
	const (
		repository    = "/repository"
		plan          = "/plan.json"
		relativePath  = "relative"
		invalidFormat = "invalid"
		unknownOption = "--unknown"
	)
	for _, arguments := range [][]string{
		nil,
		{"unsupported"},
		{nugetCreateMode},
		{nugetCanonicalizeMode, nugetSelectionFlag, ""},
		{nugetValidateMode, nugetRootFlag, repository, nugetRootFlag, "/duplicate"},
		{nugetValidateMode, nugetRootFlag, relativePath, nugetPlanFlag, plan},
		{nugetEntriesMode, nugetRootFlag, repository, nugetPlanFlag, plan, nugetFixtureFormatFlag, invalidFormat},
		{nugetValidateMode, nugetRootFlag, repository, unknownOption, plan},
	} {
		assertNugetCommand(t, arguments, exitUsage, "")
	}
}

func TestNugetPlanSelectionEnvironment(t *testing.T) {
	const selectionEnv = "LOGBREW_TEST_NUGET_ENVIRONMENT"
	const privateMarker = "sensitive-marker"
	arguments := []string{nugetCanonicalizeMode, nugetSelectionFlag, selectionEnv}
	t.Setenv(selectionEnv, "")
	assertNugetCommand(t, arguments, exitOK, "\n")
	for _, value := range append(nugetInvalidSelections(), privateMarker) {
		t.Setenv(selectionEnv, value)
		var output, diagnostic bytes.Buffer
		if runNugetPlan(arguments, &output, &diagnostic) != exitFailure || output.Len() != 0 ||
			diagnostic.String() != "invalid NuGet package selection\n" {
			t.Fatal("invalid selector was accepted or reflected")
		}
	}
	if err := os.Unsetenv(selectionEnv); err != nil {
		t.Fatal(err)
	}
	assertNugetCommand(t, arguments, exitFailure, "")
}

func TestNugetPlanAllSelectionCommands(t *testing.T) {
	const selectionEnv = "LOGBREW_TEST_NUGET_ALL_SELECTIONS"
	t.Setenv(selectionEnv, "")
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "plan.json")
	for selection, expected := range nugetFixtureSelections() {
		t.Setenv(selectionEnv, selection)
		create := []string{
			nugetCreateMode, nugetRootFlag, root, nugetSelectionFlag, selectionEnv, nugetFixtureOutputFlag, filename,
		}
		assertNugetCommand(t, create, exitOK, nugetFixtureSuccess)
		assertNugetCommand(t, []string{nugetValidateMode, nugetRootFlag, root, nugetPlanFlag, filename},
			exitOK, nugetFixtureSuccess)
		entries := []string{nugetEntriesMode, nugetRootFlag, root, nugetPlanFlag, filename, nugetFixtureFormatFlag}
		assertNugetCommand(t, append(entries, "ids"),
			exitOK, strings.ReplaceAll(expected, ",", "\n")+"\n")
		mode := "selected\n"
		if selection == "" {
			mode = "all\n"
		}
		assertNugetCommand(t, append(entries, "mode"), exitOK, mode)
	}
}

func TestNugetPlanCommands(t *testing.T) {
	const selectionEnv = "LOGBREW_TEST_NUGET_SELECTION"
	t.Setenv(selectionEnv, "LogBrew.HttpClient, LogBrew")
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	plan := filepath.Join(t.TempDir(), "plan.json")
	for _, args := range [][]string{
		{nugetCreateMode, nugetRootFlag, root, nugetSelectionFlag, selectionEnv, nugetFixtureOutputFlag, plan},
		{nugetValidateMode, nugetRootFlag, root, nugetPlanFlag, plan},
	} {
		assertNugetCommand(t, args, exitOK, nugetFixtureSuccess)
	}
	for format, expected := range map[string]string{
		"ids": "LogBrew\nLogBrew.HttpClient\n", "versions": "LogBrew=0.1.7\nLogBrew.HttpClient=0.1.2\n",
		"mode": "selected\n",
		"projects": "LogBrew\tdotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj\t0.1.7\n" +
			"LogBrew.HttpClient\tdotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj\t0.1.2\n",
	} {
		args := []string{nugetEntriesMode, nugetRootFlag, root, nugetPlanFlag, plan, nugetFixtureFormatFlag, format}
		assertNugetCommand(t, args, exitOK, expected)
	}
	assertNugetCommand(t, []string{nugetCanonicalizeMode, nugetSelectionFlag, selectionEnv}, exitOK,
		"LogBrew,LogBrew.HttpClient\n")
	data, readable := readCheckFile(plan)
	if !readable || len(data) == 0 {
		t.Fatal("written plan missing")
	}
	if !writePythonManifestFile(plan, []byte(strings.ReplaceAll(string(data), nugetFixtureVersion, "9.9.9"))) {
		t.Fatal("could not write stale plan fixture")
	}
	assertNugetCommand(t, []string{nugetValidateMode, nugetRootFlag, root, nugetPlanFlag, plan}, exitFailure, "")
}

func TestNugetPlanCreatesNestedOutput(t *testing.T) {
	const selectionEnv = "LOGBREW_TEST_NUGET_NESTED"
	t.Setenv(selectionEnv, "LogBrew.AspNetCore")
	directory := t.TempDir()
	filename := filepath.Join(directory, "nested", "release.plan")
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	arguments := []string{
		nugetCreateMode, nugetRootFlag, root, nugetSelectionFlag, selectionEnv, nugetFixtureOutputFlag, filename,
	}
	assertNugetCommand(t, arguments, exitOK, nugetFixtureSuccess)
	assertNugetCommand(t, arguments, exitOK, nugetFixtureSuccess)
	assertNugetCommand(t, []string{nugetValidateMode, nugetRootFlag, root, nugetPlanFlag, filename}, exitOK,
		nugetFixtureSuccess)
	info, err := os.Stat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != fixtureReceiptMode {
		t.Fatal("plan output is not a private regular file")
	}
	entries, err := os.ReadDir(filepath.Dir(filename))
	if err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(filename) {
		t.Fatal("plan output left a temporary file")
	}
	before, readable := readCheckFile(filename)
	if !readable {
		t.Fatal("created plan cannot be read")
	}
	arguments[2] = t.TempDir()
	assertNugetCommand(t, arguments, exitFailure, "")
	after, readable := readCheckFile(filename)
	if !readable || !bytes.Equal(before, after) {
		t.Fatal("missing source metadata replaced the preceding plan")
	}
}

func TestNugetPlanRejectsUnsafeOutput(t *testing.T) {
	t.Parallel()
	directory := confidentialityFixture(t, map[string]string{"original.plan": "original", "parent": "marker"})
	original := filepath.Join(directory, "original.plan")
	link := filepath.Join(directory, "linked.plan")
	if err := os.Symlink(original, link); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{link, directory, filepath.Join(directory, "parent", "child.plan")} {
		if writeNugetPlan(filename, []byte("{}")) {
			t.Fatal("plan accepted a linked file, directory, or invalid parent")
		}
	}
	actual, readable := readCheckFile(original)
	if !readable || string(actual) != "original" {
		t.Fatal("plan output changed the linked target")
	}
}
