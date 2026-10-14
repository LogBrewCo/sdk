package main

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

const (
	nugetRegistrationRoot  = "https://api.nuget.org/v3/registration5-gz-semver2/"
	nugetPackageRoot       = "https://api.nuget.org/v3-flatcontainer/"
	nugetCatalogRoot       = "https://api.nuget.org/v3/catalog0/data/"
	nugetCatalogTimeLayout = "2006.01.02.15.04.05"
)

type nugetPublicArtifact struct {
	sha256, registrySHA512, contentSHA256 string
	data                                  []byte
}

type nugetRegistryAddresses struct {
	metadata, packageURL string
}

func fetchNugetPublicArtifact(ctx context.Context, client *http.Client, spec *nugetArtifactSpec) *nugetPublicArtifact {
	if !spec.valid() {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, maximumDeadline)
	defer cancel()
	registryDigest := fetchNugetRegistryDigest(ctx, client, spec)
	if registryDigest == "" {
		return nil
	}
	data, readable := readNugetPublicResponse(ctx, client, spec.registryURLs().packageURL, nugetResponsePackage)
	if !readable {
		return nil
	}
	artifact := spec.bindPublicArtifact(data, registryDigest)
	if ctx.Err() != nil {
		return nil
	}
	return artifact
}

func (spec *nugetArtifactSpec) bindPublicArtifact(data []byte, registryDigest string) *nugetPublicArtifact {
	if !spec.valid() || len(data) == 0 || len(data) > nugetPackageLimit {
		return nil
	}
	digest512 := sha512.Sum512(data)
	if base64.StdEncoding.EncodeToString(digest512[:]) != registryDigest {
		return nil
	}
	content, valid := spec.contentSHA256(data)
	if !valid {
		return nil
	}
	digest256 := sha256.Sum256(data)
	return &nugetPublicArtifact{
		data: data, sha256: hex.EncodeToString(digest256[:]), registrySHA512: registryDigest, contentSHA256: content,
	}
}

func fetchNugetRegistryDigest(ctx context.Context, client *http.Client, spec *nugetArtifactSpec) string {
	addresses := spec.registryURLs()
	metadata := readNugetRegistryJSON(ctx, client, addresses.metadata)
	catalogURL, text := metadata["catalogEntry"].(string)
	if !text || metadata["packageContent"] != addresses.packageURL || !spec.validCatalogURL(catalogURL) {
		return ""
	}
	catalog := readNugetRegistryJSON(ctx, client, catalogURL)
	if catalog["id"] != spec.id || catalog[pythonManifestVersion] != spec.version ||
		catalog["packageHashAlgorithm"] != "SHA512" || !spec.dependencies.matchesGroups(catalog["dependencyGroups"]) {
		return ""
	}
	digest, valid := nugetSHA512(catalog["packageHash"])
	if !valid {
		return ""
	}
	return digest
}

func readNugetRegistryJSON(ctx context.Context, client *http.Client, address string) map[string]any {
	data, readable := readNugetPublicResponse(ctx, client, address, nugetResponseMetadata)
	document, decoded := decodeCheckDocument(data)
	if !readable || !decoded {
		return nil
	}
	return eventObject(document)
}

func (spec *nugetArtifactSpec) registryURLs() nugetRegistryAddresses {
	name := strings.ToLower(spec.id)
	versionPath := name + "/" + spec.version
	return nugetRegistryAddresses{
		metadata:   nugetRegistrationRoot + versionPath + ".json",
		packageURL: nugetPackageRoot + versionPath + "/" + name + "." + spec.version + ".nupkg",
	}
}

// Preserve the release verifier's exact NuGet.org catalog allowlist. This is
// not general service-index discovery or general version normalization.
func (spec *nugetArtifactSpec) validCatalogURL(address string) bool {
	if !spec.valid() || !strings.HasPrefix(address, nugetCatalogRoot) || strings.Contains(spec.version, "+") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(address, nugetCatalogRoot), "/")
	if len(parts) != 2 || parts[1] != strings.ToLower(spec.id)+"."+spec.version+".json" {
		return false
	}
	timestamp, err := time.Parse(nugetCatalogTimeLayout, parts[0])
	return err == nil && timestamp.Year() > 0 && timestamp.Format(nugetCatalogTimeLayout) == parts[0]
}
