package main

import (
	"strings"
	"testing"
)

func TestMavenMetadataCommand(t *testing.T) {
	t.Parallel()
	files := make(map[string]string)
	for _, prefix := range []string{
		"java/logbrew-java/", "kotlin/logbrew-kotlin/", "kotlin/logbrew-kotlin-okhttp/",
	} {
		files[prefix+"pom.xml"] = repositorySource(t, prefix+"pom.xml")
		files[prefix+policyRootGuide] = ""
	}
	assertReleaseMetadataFiles(t, "maven", files)
}

func TestMavenMetadataFields(t *testing.T) {
	t.Parallel()
	const commonFields = 10
	for _, pkg := range mavenMetadataPackages() {
		data := repositorySource(t, pkg.prefix+mavenMetadataPOM)
		fields := pkg.fields()
		expectedCount := commonFields
		if strings.HasPrefix(pkg.prefix, "java/") {
			expectedCount++
		}
		if len(fields) != expectedCount || !pkg.valid([]byte(data)) {
			t.Fatal("Maven field inventory changed or current POM rejected")
		}
		fields["description"] = parseMetadataXML([]byte(data)).value("description")
		for path, expected := range fields {
			assertMavenFieldMutations(t, pkg, data, path, expected)
		}
	}
}

func assertMavenFieldMutations(t *testing.T, pkg mavenMetadataPackage, data, path, expected string) {
	t.Helper()
	parts := strings.Split(path, "/")
	name := parts[len(parts)-1]
	open, closeTag := "<"+name+">", "</"+name+">"
	field := open + expected + closeTag
	for _, replacement := range []string{
		"", open + fixtureUnknown + closeTag, field + field,
		open + expected + "<nested/>" + closeTag,
	} {
		changed := strings.Replace(data, field, replacement, 1)
		if changed == data || pkg.valid([]byte(changed)) {
			t.Fatalf("%s field %s mutation accepted or not applied", pkg.artifact, path)
		}
	}
}

func TestMavenMetadataKotlinDependency(t *testing.T) {
	t.Parallel()
	for _, pkg := range mavenMetadataPackages() {
		if pkg.artifact != mavenMetadataKotlin {
			continue
		}
		data := repositorySource(t, pkg.prefix+mavenMetadataPOM)
		const group = "<groupId>org.jetbrains.kotlin</groupId>"
		for _, replacement := range [][2]string{
			{"org.jetbrains.kotlin", fixtureUnknown},
			{"kotlin-stdlib", fixtureUnknown},
			{"dependencies", "dependencyManagement"},
			{"<dependency>", "<other>"},
			{group, group + "</dependency><dependency>"},
		} {
			changed := strings.ReplaceAll(data, replacement[0], replacement[1])
			if changed == data || pkg.valid([]byte(changed)) {
				t.Fatal("missing or split Kotlin dependency accepted")
			}
		}
	}
}

func TestMavenMetadataDocumentShape(t *testing.T) {
	t.Parallel()
	for _, pkg := range mavenMetadataPackages() {
		data := repositorySource(t, pkg.prefix+mavenMetadataPOM)
		for _, changed := range []string{
			strings.NewReplacer("<project ", "<other ", "</project>", "</other>").Replace(data),
			strings.Replace(data, "</licenses>", "</licenses><licenses/>", 1),
			strings.Replace(data, "</developers>", "</developers><developers/>", 1),
			strings.Replace(data, "</scm>", "</scm><scm/>", 1),
		} {
			if changed == data || parseMetadataXML([]byte(changed)) == nil || pkg.valid([]byte(changed)) {
				t.Fatal("valid XML with wrong root or ambiguous metadata container was accepted")
			}
		}
	}
}

func TestMavenMetadataNamespaces(t *testing.T) {
	t.Parallel()
	for _, pkg := range mavenMetadataPackages() {
		data := repositorySource(t, pkg.prefix+mavenMetadataPOM)
		plain := strings.Replace(data, `xmlns="`+mavenMetadataNamespace+`"`, "", 1)
		prefixed := strings.Replace(data, "<artifactId>", `<m:artifactId xmlns:m="`+mavenMetadataNamespace+`">`, 1)
		prefixed = strings.Replace(prefixed, "</artifactId>", "</m:artifactId>", 1)
		if !pkg.valid([]byte(plain)) || !pkg.valid([]byte(prefixed)) {
			t.Fatal("unqualified or correctly qualified Maven metadata rejected")
		}
		for _, changed := range []string{
			strings.ReplaceAll(data, mavenMetadataNamespace, "urn:other"),
			strings.Replace(prefixed, ` xmlns:m="`+mavenMetadataNamespace+`"`, "", 1),
			strings.Replace(prefixed, `xmlns:m="`+mavenMetadataNamespace+`"`, `xmlns:m="urn:other"`, 1),
		} {
			if pkg.valid([]byte(changed)) {
				t.Fatal("unknown, unbound, or mixed Maven namespace accepted")
			}
		}
	}
}
