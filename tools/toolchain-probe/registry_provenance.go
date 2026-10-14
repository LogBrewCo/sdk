package main

import (
	"net/url"
	"strings"
)

const (
	registryNPMPredicate    = "https://slsa.dev/provenance/v1"
	registryNPMAttestations = "https://registry.npmjs.org/-/npm/v1/attestations/"
)

func registryNPMProvenanceVersions(payload any) map[string]bool {
	versions := make(map[string]bool)
	object, valid := payload.(map[string]any)
	if !valid {
		return versions
	}
	version, text := object[pythonManifestVersion].(string)
	dist := registryObjectField(object, "dist")
	attestations := registryObjectField(dist, "attestations")
	provenance := registryObjectField(attestations, "provenance")
	address, addressText := attestations["url"].(string)
	if text && addressText && provenance["predicateType"] == registryNPMPredicate &&
		strings.HasPrefix(address, registryNPMAttestations) &&
		strings.HasSuffix(address, "@"+registryQuotedVersion(version)) {
		versions[version] = true
	}
	return versions
}

func registryObjectField(object map[string]any, key string) map[string]any {
	value, valid := object[key].(map[string]any)
	if !valid {
		return nil
	}
	return value
}

func registryQuotedVersion(version string) string {
	return strings.ReplaceAll(url.QueryEscape(version), "+", "%20")
}
