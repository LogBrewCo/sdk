package main

const (
	registryDefaultVersion   = "0.1.0"
	registryRustVersion      = "0.1.7"
	registryRubyVersion      = "0.1.14"
	registryPackagistVersion = "0.1.10"
	registryMavenVersion     = "0.2.2"
)

// These registry fallback versions preserve the predecessor's release policy.
// Release-plan and package overrides supply exact per-package versions.
func registryDefaultVersions() map[string]map[string]string {
	defaults := make(map[string]map[string]string)
	for family, version := range map[string]string{
		registryRubyFamily: registryRubyVersion, registryPackagistFamily: registryPackagistVersion,
		registryCratesFamily: registryRustVersion, mavenMetadataFamily: registryMavenVersion,
	} {
		defaults[family] = make(map[string]string)
		for _, name := range registryPackageCatalog(family) {
			if family == mavenMetadataFamily {
				name = "co.logbrew:" + name
			}
			defaults[family][name] = version
		}
	}
	return defaults
}

func newRegistryVersionPolicy() *registryVersionPolicy {
	return &registryVersionPolicy{
		defaults: registryDefaultVersions(), overrides: make(map[string]map[string]string),
		version: registryDefaultVersion, provenance: false, absent: false,
	}
}
