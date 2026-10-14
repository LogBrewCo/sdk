package main

import "os"

const (
	releaseSafetyFamily   = "release-safety"
	trustedPublishersPath = ".github/publishing/trusted-publishers.md"
	githubActionsDocPath  = "docs/github-actions.md"
	nugetPlanSourcePath   = "tools/toolchain-probe/nuget_plan.go"
	aspnetPublicSmokePath = "scripts/real_user_dotnet_aspnetcore_public_nuget_smoke.sh"
)

func checkReleaseSafety(root *os.Root) bool {
	plan, read := readReleaseMetadata(root, nugetPlanSourcePath)
	if !read || !validMetadataText(plan, []string{"dotnetMetadataPackages()"}) ||
		!releaseMetadataFileExists(root, aspnetPublicSmokePath) {
		return false
	}
	for _, path := range []string{githubActionsDocPath, trustedPublishersPath} {
		data, read := readReleaseMetadata(root, path)
		required := []string{"release tag's commit", "historical tags", "repo-wide-versions"}
		if !read || !validMetadataText(data, required) {
			return false
		}
		if path == trustedPublishersPath && !validTrustedPublisherCatalog(data) {
			return false
		}
	}
	return true
}

func validTrustedPublisherCatalog(data []byte) bool {
	for _, name := range jsMetadataPackages() {
		if !validMetadataText(data, []string{name}) {
			return false
		}
	}
	for _, pkg := range pythonReleaseCatalog() {
		if !validMetadataText(data, []string{pkg.id}) {
			return false
		}
	}
	return true
}
