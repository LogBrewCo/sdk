package main

import (
	"io"
	"strings"
	"testing"
)

func TestNugetDependencyRangeCommand(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		want      string
		arguments []string
	}{
		{"[0.1.5, 0.2.0)\n", []string{pythonFixtureVersion}},
		{"[3.4.5, 4.0.0)\n", []string{"3.4.5"}},
		{"[0.9.1-preview.1, 0.10.0)\n", []string{"0.9.1-preview.1"}},
		{"", nil},
		{"", []string{"2.4"}},
		{"", []string{"1.2.3\n"}},
		{"", []string{"999999999999999999.1.0"}},
		{"", []string{"3.4.5", "extra"}},
	} {
		var output strings.Builder
		arguments := append([]string{"dependency-range"}, test.arguments...)
		code := runNugetPlan(arguments, &output, io.Discard)
		if (code == exitOK) != (test.want != "") || output.String() != test.want {
			t.Fatalf("dependency range returned %d, %q", code, output.String())
		}
	}
}

func TestNugetDependencyRangeWorkflow(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, nugetPublicationWorkflow)
	if strings.Contains(source, "from release_metadata_dotnet import") {
		t.Fatal("NuGet dependency range still uses Python")
	}
	requireOrderedSource(t, source, "- name: Build protected native release verifier",
		nativeProbeInvocation+` nuget-plan dependency-range "$core_version"`,
		`core_dependency_range_msbuild="${core_dependency_range/, /%2C}"`)
}

func TestNugetDependencyRangeOutputFailure(t *testing.T) {
	t.Parallel()
	for _, output := range []io.Writer{rejectedCheckOutput{}, shortCheckOutput{}} {
		if runNugetPlan([]string{"dependency-range", pythonFixtureVersion}, output, io.Discard) != exitFailure {
			t.Fatal("dependency range accepted failed output")
		}
	}
}
