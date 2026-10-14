package main

import (
	"os"
	"strings"
)

const (
	mavenMetadataFamily = "maven"
	mavenMetadataPOM    = "pom.xml"
	mavenMetadataKotlin = "logbrew-kotlin"
	// Maven's canonical XML namespace is an identifier, not a fetched URL. Reviewed 2026-09-12.
	mavenMetadataNamespace = "http://maven.apache.org/POM/4.0.0" //nolint:revive // unsecure-url-scheme: POM identifier.
)

type mavenMetadataPackage struct {
	prefix   string
	artifact string
	name     string
	version  string
}

func mavenMetadataPackages() []mavenMetadataPackage {
	return []mavenMetadataPackage{
		{"java/logbrew-java/", "logbrew-sdk", "LogBrew Java SDK", "0.1.8"},
		{"kotlin/logbrew-kotlin/", mavenMetadataKotlin, "LogBrew Kotlin SDK", "0.2.2"},
		{"kotlin/logbrew-kotlin-okhttp/", "logbrew-kotlin-okhttp", "LogBrew Kotlin OkHttp Integration", "0.2.2"},
	}
}

func checkMavenMetadata(root *os.Root) bool {
	for _, pkg := range mavenMetadataPackages() {
		data, read := readReleaseMetadata(root, pkg.prefix+mavenMetadataPOM)
		if !read || !releaseMetadataFileExists(root, pkg.prefix+policyRootGuide) || !pkg.valid(data) {
			return false
		}
	}
	return true
}

func (pkg mavenMetadataPackage) fields() map[string]string {
	const repository = "https://github.com/LogBrewCo/sdk"
	fields := map[string]string{
		"groupId": "co.logbrew", "artifactId": pkg.artifact, pythonManifestVersion: pkg.version,
		"packaging": "jar", "name": pkg.name, "url": repository,
		"licenses/license/name": releaseMetadataLicense, "licenses/license/url": "https://opensource.org/license/mit",
		"developers/developer/name": "LogBrew", "scm/url": repository,
	}
	if pkg.artifact == "logbrew-sdk" {
		fields["properties/maven.compiler.release"] = "11"
	}
	return fields
}

func (pkg mavenMetadataPackage) valid(data []byte) bool {
	project := parseMetadataXML(data)
	if project == nil || project.name != "project" || !strings.Contains(project.value("description"), "LogBrew") {
		return false
	}
	if (project.namespace != "" && project.namespace != mavenMetadataNamespace) ||
		!project.hasNamespace(project.namespace) {
		return false
	}
	for path, expected := range pkg.fields() {
		if project.value(strings.Split(path, "/")...) != expected {
			return false
		}
	}
	if pkg.artifact != mavenMetadataKotlin {
		return true
	}
	dependencies := project.path("dependencies")
	if dependencies == nil {
		return false
	}
	for _, dependency := range dependencies.children {
		if dependency.name == "dependency" && dependency.value("groupId") == "org.jetbrains.kotlin" &&
			dependency.value("artifactId") == "kotlin-stdlib" {
			return true
		}
	}
	return false
}
