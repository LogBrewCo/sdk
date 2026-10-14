package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const (
	repoWideFixtureVersion  = "1.2.3"
	repoWideFixturePackages = 33
)

func TestRepoWideReleaseVersions(t *testing.T) {
	t.Parallel()
	files := make(map[string]string)
	manifests := repoWideVersionManifests()
	if len(manifests) != repoWideFixturePackages {
		t.Fatal("repo-wide guard lost part of the publishable catalog")
	}
	expectedNames := strings.Fields(`@logbrew/sdk @logbrew/browser @logbrew/node @logbrew/prisma
		@logbrew/bullmq @logbrew/kafkajs @logbrew/amqplib @logbrew/aws-sqs @logbrew/express @logbrew/fastify
		@logbrew/nestjs @logbrew/angular @logbrew/vue @logbrew/svelte @logbrew/react @logbrew/react-native @logbrew/next
		logbrew-sdk logbrew-fastapi logbrew-flask logbrew-django logbrew logbrew-sdk
		LogBrew LogBrew.AspNetCore LogBrew.EntityFrameworkCore LogBrew.Hangfire LogBrew.HttpClient
		LogBrew.StackExchangeRedis LogBrew.OpenTelemetry co.logbrew:logbrew-sdk co.logbrew:logbrew-kotlin
		co.logbrew:logbrew-kotlin-okhttp`)
	names := make([]string, 0, len(manifests))
	for _, manifest := range manifests {
		names = append(names, manifest.name)
	}
	slices.Sort(names)
	slices.Sort(expectedNames)
	if !slices.Equal(names, expectedNames) {
		t.Fatal("repo-wide package identities changed")
	}
	for path, manifest := range manifests {
		source := repositorySource(t, path)
		version := manifest.read([]byte(source))
		if version == "" {
			t.Fatal("current manifest version cannot be read")
		}
		files[path] = strings.ReplaceAll(source, version, repoWideFixtureVersion)
	}
	root := confidentialityFixture(t, files)
	for _, tag := range []string{"v1.2.3", "refs/tags/v1.2.3"} {
		assertRepoWideVersionReceipt(t, root, tag, exitOK, 0)
	}
	for path, content := range files {
		changed := []byte(strings.ReplaceAll(content, repoWideFixtureVersion, "1.2.4"))
		if err := os.WriteFile(filepath.Join(root, path), changed, fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
		receipt := assertRepoWideVersionReceipt(t, root, "v1.2.3", exitFailure, 1)
		if receipt.Mismatches[0].Manifest != path || receipt.Mismatches[0].Name != manifests[path].name ||
			receipt.Mismatches[0].Version != "1.2.4" {
			t.Fatal("mismatch lost package identity or captured version")
		}
		if err := os.WriteFile(filepath.Join(root, path), []byte(content), fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
	}
}

func assertRepoWideVersionReceipt(t *testing.T, root, tag string, code, mismatches int) repoWideVersionReceipt {
	t.Helper()
	var output, diagnostic bytes.Buffer
	actual := runRepoWideVersions([]string{tag, root}, &output, &diagnostic)
	var receipt repoWideVersionReceipt
	if actual != code || json.Unmarshal(output.Bytes(), &receipt) != nil || len(receipt.Mismatches) != mismatches ||
		receipt.ExpectedVersion != repoWideFixtureVersion || receipt.PackagesChecked != repoWideFixturePackages ||
		receipt.Valid != (code == exitOK) {
		t.Fatal("repo-wide version result or mismatch details changed")
	}
	return receipt
}

func TestRepoWideVersionReadersRejectAmbiguity(t *testing.T) {
	t.Parallel()
	for _, manifest := range repoWideVersionManifests() {
		for _, data := range []string{"", fixtureUnknown, "\xff", strings.Repeat(" ", pythonManifestLimit+1)} {
			if manifest.read([]byte(data)) != "" {
				t.Fatal("malformed or oversized version source accepted")
			}
		}
	}
	for _, data := range []string{
		`{"version":"1.2.3","version":"1.2.4"}`, `{"version":123}`, `{"version":null}`,
	} {
		if jsonPackageVersion([]byte(data)) != "" {
			t.Fatal("duplicate or mistyped version accepted")
		}
	}
	for _, data := range []string{
		"module LogBrew\nVERSION = \"1.2.3\"\nVERSION = \"1.2.4\"\nend\n",
		"module Other\nVERSION = \"1.2.3\"\nend\n", "# VERSION = \"1.2.3\"\n",
	} {
		if rubyConstantVersion([]byte(data)) != "" {
			t.Fatal("ambiguous, unrelated, or comment-only Ruby version accepted")
		}
	}
}

func TestRepoWideVersionWorkflow(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, ".github/workflows/publish-release.yml")
	steps := yamlField(parseMetadataYAML([]byte(source)), "jobs", "dispatch-publish", "steps")
	if steps == nil {
		t.Fatal("release dispatch steps unavailable")
	}
	bootstrap, guards := 0, 0
	const condition = "${{ steps.release.outputs.release_kind == 'repo-wide' }}"
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, nugetNativeAction) {
			if !yamlScalar(yamlField(step, "if"), yamlStringTag, nugetDispatchCondition) {
				t.Fatal("native guard bootstrap changed its release scope")
			}
			bootstrap++
		}
		if !yamlScalar(yamlField(step, "name"), yamlStringTag, "Guard repo-wide release package versions") {
			continue
		}
		guards++
		if bootstrap != 1 || !yamlScalar(yamlField(step, "if"), yamlStringTag, condition) ||
			!yamlScalar(yamlField(step, "env", "REF"), yamlStringTag, "${{ steps.release.outputs.ref }}") ||
			!yamlScalar(yamlField(step, "run"), yamlStringTag,
				nativeProbeInvocation+` repo-wide-versions "$REF" "$GITHUB_WORKSPACE"`+"\n") {
			t.Fatal("repo-wide guard lacks native execution, binding, ordering, or scope")
		}
	}
	if bootstrap != 1 || guards != 1 || strings.Contains(source, "check_repo_wide_release_versions.py") {
		t.Fatal("repo-wide guard missing, duplicated, or using legacy execution")
	}
}

func TestRepoWideVersionRejectedInputs(t *testing.T) {
	t.Parallel()
	const excessiveTagBytes = 129
	for _, tag := range []string{
		"main", "go/logbrew/v1.2.3", "v1.2", "v1.2.3\n", "v1.2.3+", strings.Repeat("v", excessiveTagBytes),
	} {
		var output, diagnostic bytes.Buffer
		if runRepoWideVersions([]string{tag, t.TempDir()}, &output, &diagnostic) != exitUsage || output.Len() != 0 {
			t.Fatal("non-repository release tag accepted")
		}
	}
	for _, tag := range []string{"v1.2.3-rc.1", "v1.2.3+build.4", "refs/tags/v1.2.3-rc.1+build.4"} {
		if repoWideReleaseVersion(tag) == "" {
			t.Fatal("supported prerelease/build tag rejected")
		}
	}
	var output, diagnostic bytes.Buffer
	if runRepoWideVersions([]string{"v1.2.3", t.TempDir()}, &output, &diagnostic) != exitFailure || output.Len() != 0 {
		t.Fatal("missing manifests reported as known versions")
	}
}
