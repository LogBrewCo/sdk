package main

import (
	"io"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/pelletier/go-toml/v2"
)

const (
	releaseMetadataScript     = "scripts/check_release_metadata.py"
	releaseMetadataMode       = "release-metadata"
	releaseMetadataKeyword    = "logbrew"
	releaseMetadataLicense    = "MIT"
	releaseMetadataLicenseKey = "license"
	releaseMetadataRepository = "https://github.com/LogBrewCo/sdk"
	releaseMetadataReadme     = "readme"
	releaseMetadataAll        = "all"
	rustMetadataManifest      = "rust/logbrew/Cargo.toml"
	rustMetadataReadme        = "rust/logbrew/README.md"
)

func runReleaseMetadata(arguments []string, output, diagnostic io.Writer) int {
	checks := releaseMetadataChecks()
	if len(arguments) > 0 && arguments[0] == releaseMetadataAll {
		if len(arguments) < 2 || !configureReleaseMetadataOverrides(checks, arguments[2:]) {
			return writeText(diagnostic, "Invalid aggregate release metadata overrides\n", exitUsage)
		}
		arguments = arguments[:2]
	}
	allChecks := maps.Clone(checks)
	checks[releaseMetadataAll] = func(root *os.Root) bool { return checkAllReleaseMetadata(root, allChecks) }
	return runSelectedReleaseMetadata(arguments, output, diagnostic, checks)
}

func releaseMetadataChecks() map[string]func(*os.Root) bool {
	checks := map[string]func(*os.Root) bool{
		releaseSafetyFamily:        checkReleaseSafety,
		publicationArtifactsFamily: checkPublicationArtifacts,
		releaseControlFamily:       checkReleaseControl,
		releaseDispatchFamily:      checkReleaseDispatch,
		pythonMetadataDirectory:    checkPythonMetadataRepository,
		areaRust:                   checkRustMetadata,
		phpMetadataFamily:          checkPHPMetadata,
		mavenMetadataFamily:        checkMavenMetadata,
		dotnetMetadataFamily:       checkDotnetMetadata,
		unityMetadataFamily:        checkUnityMetadata,
		areaJS:                     checkJSMetadata,
		reconciliationAccessFamily: checkReconciliationAccess,
	}
	for family, policy := range sourceMetadataPolicies() {
		checks[family] = policy.check
	}
	return checks
}

func runSelectedReleaseMetadata(arguments []string, output, diagnostic io.Writer,
	checks map[string]func(*os.Root) bool,
) int {
	if len(arguments) > 2 && arguments[0] == dotnetMetadataFamily {
		checks[dotnetMetadataFamily] = dotnetMetadataOverrideCheck(arguments[2:])
		arguments = arguments[:2]
	}
	if len(arguments) > 2 && arguments[0] == areaJS {
		checks[areaJS] = jsMetadataOverrideCheck(arguments[2:])
		arguments = arguments[:2]
	}
	if len(arguments) != 2 || checks[arguments[0]] == nil || !filepath.IsAbs(arguments[1]) {
		return writeText(diagnostic,
			"release-metadata requires python, rust, php, c, cpp, objc, swift, go, ruby, maven, dotnet, "+
				"unity, javascript, reconciliation-access, release-dispatch, release-control, "+
				"publication-artifacts, release-safety, root, or all "+
				"and an absolute repository directory\n",
			exitUsage)
	}
	root, err := os.OpenRoot(arguments[1])
	if err != nil {
		return writeText(diagnostic, "Release metadata repository unavailable\n", exitFailure)
	}
	valid := checks[arguments[0]](root)
	if closeError := root.Close(); !valid || closeError != nil {
		return writeText(diagnostic, "Release metadata validation failed\n", exitFailure)
	}
	return writeText(output, `{"scope":"`+arguments[0]+`_release_metadata","valid":true}`+"\n", exitOK)
}

func readReleaseMetadata(root *os.Root, name string) ([]byte, bool) {
	file, err := openRootCheckInput(root, name)
	if err != nil {
		return nil, false
	}
	return readCheckInputLimit(file, pythonManifestLimit)
}

func releaseMetadataFileExists(root *os.Root, name string) bool {
	file, err := openRootCheckInput(root, name)
	if err != nil {
		return false
	}
	return file.Close() == nil
}

func metadataHasKeyword(value any) bool {
	keywords, array := value.([]any)
	if !array {
		return false
	}
	for _, keyword := range keywords {
		if keyword == releaseMetadataKeyword {
			return true
		}
	}
	return false
}

func decodeReleaseMetadata(data []byte, section string) map[string]any {
	var document map[string]any
	if len(data) > pythonManifestLimit || !utf8.Valid(data) || toml.Unmarshal(data, &document) != nil {
		return nil
	}
	return eventObject(document[section])
}

func checkRustMetadata(root *os.Root) bool {
	manifest, manifestRead := readReleaseMetadata(root, rustMetadataManifest)
	readme, readmeRead := readReleaseMetadata(root, rustMetadataReadme)
	return manifestRead && readmeRead && validRustMetadata(manifest, readme)
}

func validRustMetadata(manifest, readme []byte) bool {
	project := decodeReleaseMetadata(manifest, "package")
	if project == nil {
		return false
	}
	for key, expected := range map[string]string{
		pythonPublicName: releaseMetadataKeyword, pythonManifestVersion: "0.1.7",
		releaseMetadataLicenseKey: releaseMetadataLicense, releaseMetadataReadme: policyRootGuide,
		workflowRepositoryKey: releaseMetadataRepository,
	} {
		if project[key] != expected {
			return false
		}
	}
	description, text := project["description"].(string)
	return text && strings.Contains(description, "LogBrew") && metadataHasKeyword(project["keywords"]) &&
		validMetadataText(readme, []string{
			metadataMetricsHeading, "MetricEvent", "client.metric", metadataCardinalityGuidance,
			"OpenTelemetry Span Exporter", "opentelemetry-exporter",
		})
}
