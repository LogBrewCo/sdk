package main

import (
	"strings"
	"testing"
)

func TestMetadataXMLAnalyzerExceptionScope(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, "tools/toolchain-probe/xml_metadata.go")
	const directive = "//nolint:gosec,nolintlint // G709: bounded token parser; unstable finding documented above."
	if strings.Count(source, "//nolint:") != 1 || !strings.Contains(source,
		directive+"\n\tdecoder := xml.NewDecoder(bytes.NewReader(data))") {
		t.Fatal("XML analyzer exception moved or widened")
	}
	requireSourceText(t, source, "Reviewed 2026-09-12", "TestMetadataXMLRejectedDocuments",
		"https://github.com/securego/gosec/issues/1712")
}

func TestMetadataXMLRejectedDocuments(t *testing.T) {
	t.Parallel()
	for _, data := range []string{
		"", "<project>", "<project></other>", "<project/>trailing", "leading<project/>",
		"<project/><project/>", "<project>\xff</project>", "<project>&unknown;</project>",
		`<project x="1" x="2"/>`, `<!DOCTYPE project><project/>`,
		`<!DOCTYPE project [<!ENTITY value "data">]><project>&value;</project>`,
		`<!DOCTYPE project SYSTEM "https://example.com/schema.dtd"><project/>`,
		`<!DOCTYPE project [<!ENTITY value SYSTEM "file:///unavailable">]><project>&value;</project>`,
		`<?work data?><project/>`, `<project><?xml version="1.0"?></project>`,
		`<?xml version="1.0"?><?xml version="1.0"?><project/>`,
		`<?xml version="1.0" encoding="ISO-8859-1"?><project/>`,
		strings.Repeat(" ", pythonManifestLimit) + "<project/>",
		strings.Repeat("<n>", metadataXMLDepth+1) + strings.Repeat("</n>", metadataXMLDepth+1),
		"<project>" + strings.Repeat("<n/>", metadataXMLNodes) + "</project>",
	} {
		if parseMetadataXML([]byte(data)) != nil {
			t.Fatal("malformed, unsupported, or oversized XML accepted")
		}
	}
}

func TestMetadataXMLAcceptedDocuments(t *testing.T) {
	t.Parallel()
	for _, data := range []string{
		"<project/>", `<?xml version="1.0" encoding="UTF-8"?><project/>`,
		"<!-- comment --><project>text &amp; more</project><!-- comment -->",
		strings.Repeat("<n>", metadataXMLDepth) + strings.Repeat("</n>", metadataXMLDepth),
		"<project>" + strings.Repeat("<n/>", metadataXMLNodes-1) + "</project>",
		"<project/>" + strings.Repeat(" ", pythonManifestLimit-len("<project/>")),
	} {
		if parseMetadataXML([]byte(data)) == nil {
			t.Fatal("supported XML or exact resource boundary rejected")
		}
	}
}

func TestMetadataXMLPaths(t *testing.T) {
	t.Parallel()
	for _, data := range []string{
		"<project><name> LogBrew </name></project>",
		`<m:project xmlns:m="urn:metadata"><m:name><![CDATA[ LogBrew ]]></m:name></m:project>`,
	} {
		node := parseMetadataXML([]byte(data))
		if node == nil || node.value("name") != "LogBrew" || node.value("missing", "name") != "" {
			t.Fatal("namespace, whitespace, CDATA, or missing-path semantics changed")
		}
	}
	for _, data := range []string{
		"<project><name>LogBrew</name><name>LogBrew</name></project>",
		"<project><name>LogBrew<nested/></name></project>",
	} {
		node := parseMetadataXML([]byte(data))
		if node == nil || node.value("name") != "" {
			t.Fatal("ambiguous or mixed-content metadata field accepted")
		}
	}
}

func TestMetadataXMLAttributes(t *testing.T) {
	t.Parallel()
	node := parseMetadataXML([]byte(`<project xmlns:p="urn:other" Include="A&amp;B" p:Include="other">` +
		`<child Include="child"/></project>`))
	if node == nil || node.attribute("Include") != "A&B" || node.attribute("missing") != "" ||
		node.path("child").attribute("Include") != "child" {
		t.Fatal("XML attribute ownership, namespace or entity decoding changed")
	}
	var absent *metadataXMLNode
	if absent.attribute("Include") != "" {
		t.Fatal("missing XML node returned an attribute")
	}
}
