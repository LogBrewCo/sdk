package main

import (
	"strings"
	"testing"
)

func checkConfidentialityDomain(t *testing.T, files map[string]string, findings int) confidentialityReport {
	t.Helper()
	for name, body := range files {
		files[name] = policyFixtureLine(body)
	}
	report := scanConfidentiality(t.Context(), confidentialityFixture(t, files))
	want := confidentialityPassed
	if findings > 0 {
		want = confidentialityFailed
	}
	if report.Status != want || report.FailureCode != "" || len(report.Findings) != findings ||
		report.FilesScanned != len(files) || report.FilesTotal != len(files) {
		t.Fatalf("domain scope changed: %+v", report)
	}
	return report
}

func TestConfidentialityDotnetHTTPPaths(t *testing.T) {
	t.Parallel()
	const (
		source = "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/"
		client = "dotnet/logbrew-dotnet/tests/LogBrew.HttpClient.Tests/Program.cs"
	)
	checkConfidentialityDomain(t, map[string]string{
		source + "LogBrewHttpClientFactoryCorrelation.cs":   "requestUri.{uriKind} != Uri{uriKind}.D" + "ns",
		source + "README.md":                                "Captured fields include a normalized {resolver} host.",
		source + "examples/HttpClientFactoryCorrelation.cs": "// Only the normalized {resolver} host is captured.",
		client: "using var {resolver}Response = await client.GetAsync(request);",
	}, 0)
	checkConfidentialityDomain(t, map[string]string{
		source + "LogBrewHttpClientFactoryCorrelation.cs": "The {resolver} value contains a cre" + "dential.",
		source + "OtherHttpClientCorrelation.cs":          "The {resolver} host is captured.",
	}, 2)
}

func TestConfidentialityDotnetDurableSyntax(t *testing.T) {
	t.Parallel()
	const (
		source     = "dotnet/logbrew-dotnet/src/LogBrew/"
		testSource = "dotnet/logbrew-dotnet/tests/LogBrew.Tests/DurableDeliveryContractTests.cs"
		nearMisses = 6
	)
	checkConfidentialityDomain(t, map[string]string{
		ciWorkflowPath: "    {plan}:\n",
		"dotnet/logbrew-dotnet/README.md": "Only one process may own a store. " +
			"Recovery fails closed for missing or wrong keys, " +
			"corruption, unknown files, unsafe ownership, links, or replacement. Supply one primary " +
			"key and a bounded list of previous keys to rotate records during recovery; new records " +
			"always use the primary key. Key IDs identify keys but are not {hidden} and must contain " +
			"only stable letters, numbers, `.`, `_`, or `-`.",
		source + "DurableEventStore.cs": "{cleanTitle}Acknowledged(recordNames);",
		source + "DurableStoreFileSystem.cs": strings.Join([]string{
			"private const uint WindowsShareRead = 1;", "private const uint WindowsShareWrite = 2;",
			"private const uint WindowsShareDelete = 4;",
			"private const uint Windows{archiveTitle}Semantics = 0x02000000;",
			"WindowsShareRead | WindowsShareDelete,", "WindowsShareRead | (allowDelete ? WindowsShareDelete : 0),",
			"WindowsShareRead | WindowsShareWrite,", "Windows{archiveTitle}Semantics | WindowsOpenReparsePoint,",
		}, "\n"),
		testSource: "AcknowledgedPrefix{cleanTitle}ResumesAfterExit();\n" +
			`"acknowledged prefix reappeared after {clean} restart";`,
	}, 0)
	checkConfidentialityDomain(t, map[string]string{
		ciWorkflowPath: "    custom-{plan}:\n", "dotnet/logbrew-dotnet/README.md": "The value is {hidden}.",
		source + "DurableEventStore.cs": "var pending{cleanTitle} = true;",
		source + "DurableStoreFileSystem.cs": "private const uint Windows{archiveTitle}Policy = 1;\n" +
			"private const uint WindowsShareRead = 1; // " + confidentialityRemoteTerm + " {archive}",
		testSource: "unexpected {clean} behavior",
	}, nearMisses)
}

func TestConfidentialityDomainDisclosureBoundaries(t *testing.T) {
	t.Parallel()
	checkConfidentialityDomain(t, map[string]string{
		"notes.txt": "business {plan}\ncust" + "omer {hidden}\n{clean} private {archive}",
	}, 3)
	const source = "go/logbrew/http_client_trace.go"
	report := checkConfidentialityDomain(t, map[string]string{
		source: `host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(request.URL.Host` + `name()), "."))` +
			"\nnote := \"production {host} inventory\"",
	}, 1)
	if report.Findings[0].Path != source || report.Findings[0].Line != 2 {
		t.Fatal("Go structured URL access and free-form disclosure became indistinguishable")
	}
}
