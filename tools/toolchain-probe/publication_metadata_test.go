package main

import (
	"io"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func TestPublicationMetadataSelectedRoot(t *testing.T) {
	t.Parallel()
	files := map[string]string{
		publicationWorkflow:      repositorySource(t, publicationWorkflow),
		nugetPublicationWorkflow: repositorySource(t, nugetPublicationWorkflow),
		npmPublisherPath:         repositorySource(t, npmPublisherPath),
	}
	root := confidentialityFixture(t, files)
	if runReleaseMetadata([]string{publicationArtifactsFamily, root}, io.Discard, io.Discard) != exitOK {
		t.Fatal("valid selected publication artifacts rejected")
	}
	for _, omitted := range []string{
		"nuget-plan create", "nuget-plan validate", "httpclient_content_sha256", "--skip-duplicate",
		"python-archive create-manifest", "--artifact-root dist/pypi", "LOGBREW_SWIFTPM_EXPECTED_REVISION",
		"--require-released-package-set", "--maven-plan-scope selected", "--maven-plan-scope dependencies",
		"bash scripts/check_maven_central_auth_preflight.sh", "generated Central Portal publishing values",
	} {
		changed := make(map[string]string)
		applied := false
		for name, source := range files {
			changed[name] = strings.ReplaceAll(source, omitted, "omitted-artifact-proof")
			applied = applied || changed[name] != source
		}
		root = confidentialityFixture(t, changed)
		result := runReleaseMetadata([]string{publicationArtifactsFamily, root}, io.Discard, io.Discard)
		if !applied || result == exitOK {
			t.Errorf("missing publication artifact proof accepted: %s", omitted)
		}
	}
}

func TestPublicationMavenOrdering(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, publicationWorkflow)
	for _, mutation := range []string{"premature-verification", "repeat-upload"} {
		changed := reorderedMavenFixture(t, source)
		if mutation == "repeat-upload" {
			repeatedEndpoint := mavenUploadEndpoint + " " + mavenUploadEndpoint
			changed = []byte(strings.Replace(source, mavenUploadEndpoint, repeatedEndpoint, 1))
		}
		root := confidentialityFixture(t, map[string]string{
			publicationWorkflow:      string(changed),
			nugetPublicationWorkflow: repositorySource(t, nugetPublicationWorkflow),
			npmPublisherPath:         repositorySource(t, npmPublisherPath),
		})
		if runReleaseMetadata([]string{publicationArtifactsFamily, root}, io.Discard, io.Discard) == exitOK {
			t.Errorf("unsafe Maven publication accepted: %s", mutation)
		}
	}
}

func TestPublicationNPMTrust(t *testing.T) {
	t.Parallel()
	workflow := []byte(repositorySource(t, publicationWorkflow))
	publisher := []byte(repositorySource(t, npmPublisherPath))
	for _, needle := range npmPublisherRequirements() {
		changed := []byte(strings.ReplaceAll(string(publisher), needle, "omitted-trust-proof"))
		if validPublicationNPM(workflow, changed) {
			t.Errorf("missing npm publisher proof accepted: %s", needle)
		}
	}
	for _, needle := range npmWorkflowRequirements() {
		changed := []byte(strings.ReplaceAll(string(workflow), needle, "omitted-trust-proof"))
		if validPublicationNPM(changed, publisher) {
			t.Errorf("missing npm workflow proof accepted: %s", needle)
		}
	}
}

func reorderedMavenFixture(t *testing.T, source string) []byte {
	t.Helper()
	document := parseMetadataYAML([]byte(source))
	steps := yamlField(document, "jobs", "maven", "steps")
	if steps == nil || steps.Kind != yaml.SequenceNode {
		t.Fatal("Maven steps unavailable")
	}
	wait, verify := -1, -1
	for index, step := range steps.Content {
		name := yamlField(step, pythonPublicName)
		if name == nil {
			continue
		}
		switch name.Value {
		case "Wait for Maven Central deployment":
			wait = index
		case "Verify Maven Central publication":
			verify = index
		default:
			continue
		}
	}
	if wait < 0 || verify < 0 {
		t.Fatal("Maven verification steps unavailable")
	}
	steps.Content[wait], steps.Content[verify] = steps.Content[verify], steps.Content[wait]
	changed, err := yaml.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return changed
}

func TestPublicationMavenCheckoutAuthentication(t *testing.T) {
	t.Parallel()
	document := parseMetadataYAML([]byte(repositorySource(t, publicationWorkflow)))
	steps := yamlField(document, "jobs", "maven", "steps")
	for _, step := range steps.Content {
		if !yamlScalar(yamlField(step, "uses"), yamlStringTag, workflowCheckoutAction) {
			continue
		}
		auth := checkoutPersistence(step)
		original := auth.Value
		auth.Value = fixtureTrueJSON
		changed, err := yaml.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		if validPublicationMaven(changed) {
			t.Error("Maven checkout retaining authentication accepted")
		}
		auth.Value = original
	}
}
