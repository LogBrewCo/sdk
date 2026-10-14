package main

import (
	"strings"
	"testing"
)

const (
	policyQueueUndo     = "_{undo}(worker, method, previous)"
	policyQueueTeardown = "self.add{cleanTitle}(connection.flushdb)"
)

type confidentialityPolicyCase struct {
	name, path, line string
	allowed          bool
}

func policyFixtureLine(line string) string {
	return strings.NewReplacer(
		"{undo}", policyUndoTerm, "{auth}", policyAuthTerm,
		"{authTitle}", "To"+"ken", "{hidden}", "sec"+"ret", "{hiddenTitle}", "Sec"+"ret",
		"{pass}", confidentialityFixtureTerm, "{clean}", policyCleanTerm,
		"{cleanTitle}", "Clean"+"up", "{host}", policyHostTerm,
		"{archive}", "back"+"up", "{archiveTitle}", "Back"+"up",
		"{resolver}", "d"+"ns", "{plan}", "stra"+"tegy",
		"{uriKind}", "Host"+"NameType",
		"{centralPass}", strings.ToUpper(policyCentralAuth), "{centralUser}", strings.ToUpper(policyCentralUser),
	).Replace(line)
}

func checkPolicyCases(t *testing.T, cases []confidentialityPolicyCase) {
	t.Helper()
	policy := newConfidentialityPolicy()
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if actual := policy.allowed(test.path, policyFixtureLine(test.line)); actual != test.allowed {
				t.Fatalf("policy for %s = %v, want %v", test.name, actual, test.allowed)
			}
		})
	}
}

func TestConfidentialityPolicyOwnership(t *testing.T) {
	t.Parallel()
	checkPolicyCases(t, []confidentialityPolicyCase{
		{
			"queue method", "python/logbrew_py/src/logbrew_sdk/_arq_client.py",
			policyQueueUndo, true,
		},
		{
			"unrelated method", "python/logbrew_py/src/logbrew_sdk/unrelated.py",
			policyQueueUndo, false,
		},
		{
			"queue extra term", "python/logbrew_py/src/logbrew_sdk/_rq_client.py",
			"_{undo}() arbitrary {hidden} text", false,
		},
		{
			"queue teardown", "python/logbrew_py/tests/test_rq_client.py",
			policyQueueTeardown, true,
		},
		{"unrelated teardown", "python/logbrew_py/tests/other.py", policyQueueTeardown, false},
		{"rust context", "rust/logbrew/src/telemetry_context.rs", "{auth}: u64,", true},
		{"rust auth", "rust/logbrew/src/telemetry_context.rs", `let auth_{auth} = "unsafe";`, false},
		{"rust unrelated", "rust/logbrew/src/unrelated.rs", "{auth}: u64,", false},
		{
			"rails fixture", "scripts/real_user_ruby_rails_smoke.sh",
			`config.{hidden}_key_base = "installed-rails-smoke-{hidden}-key-base"`, true,
		},
		{"rails arbitrary", "scripts/real_user_ruby_rails_smoke.sh", "# arbitrary {hidden} text", false},
		{"angular", "js/logbrew-angular/index.js", `new Injection{authTitle}("LogBrew context")`, true},
		{"unrelated injection", "js/other/index.js", `new Injection{authTitle}("LogBrew context")`, false},
		{"fake query", "scripts/real_user_node_smoke.sh", "fetch('/fail?{auth}={hidden}')", true},
		{"unrelated fake query", "scripts/other.sh", "fetch('/fail?{auth}={hidden}')", false},
		{"js uninstall", "js/logbrew-kafkajs/index.js", "state.{undo}s.pop()();", true},
		{"unexpected", policyRootGuide, "production {pass}: fixture", false},
	})
}

func TestConfidentialityPublishingPolicy(t *testing.T) {
	t.Parallel()
	const workflow = ".github/workflows/reconcile.yml"
	checkPolicyCases(t, []confidentialityPolicyCase{
		{"pino fixture", "js/logbrew-js/test/sdk.test.js", `requestUrl: "/checkout/42?{auth}=hidden",`, true},
		{"pino arbitrary", "js/logbrew-js/test/sdk.test.js", `console.log("arbitrary {auth}")`, false},
		{"workflow inheritance", publishWorkflowPath, "{hidden}s: inherit", true},
		{"other inheritance", ".github/workflows/other.yml", "{hidden}s: inherit", false},
		{"workflow auth", workflow, "GITHUB_AUTHORIZATION: ${{ github.{auth} }}", true},
		{"workflow input", workflow, "github-{auth}: ${{ github.{auth} }}", true},
		{"untrusted auth", workflow, "github-{auth}: untrusted-value", false},
		{
			"removed consumer", "scripts/real_user_python_public_pypi_smoke.sh",
			`parsed.{host} != "files.pythonhosted.org"`, false,
		},
		{"other host", "scripts/other.py", "print(request.{host})", false},
		{"upload auth", "js/logbrew-js/release-artifacts-build.cjs", "const {auth}Env = upload.{auth}Env;", true},
		{"upload declaration", "js/logbrew-next/release-artifacts.d.ts", "{auth}Env?: string;", true},
	})
}

func TestConfidentialityNativePolicy(t *testing.T) {
	t.Parallel()
	const (
		dotnetPath = "dotnet/Source.cs"
		javaPath   = "java/logbrew-java/src/main/java/co/logbrew/sdk/PersistenceCrypto.java"
		rnPath     = "js/logbrew-react-native/apple-native-diagnostics.js"
	)
	checkPolicyCases(t, []confidentialityPolicyCase{
		{"cancellation", dotnetPath, "return SendAsync(request, cancellation{authTitle});", true},
		{
			"cancellation script", "scripts/real_user_dotnet_smoke.sh",
			"Cancellation{authTitle}Source cancellation;", true,
		},
		{"analyzer directive", dotnetPath, "#pragma warning {undo} CA1031", true},
		{"other pragma", dotnetPath, "#pragma warning {undo} CA1032", false},
		{"java key import", javaPath, "import javax.crypto.spec.{hiddenTitle}KeySpec;", true},
		{"java key use", javaPath, `new {hiddenTitle}KeySpec(key, "AES"),`, true},
		{"java unsafe key", javaPath, `new {hiddenTitle}KeySpec(raw{hiddenTitle}, "AES"),`, false},
		{"endpoint guard", rnPath, "if (parsed.{pass}) reject();", true},
		{"endpoint extra term", rnPath, "parsed.{pass}; {hidden}", false},
	})
}

func TestConfidentialityRestorationLinesRemainExact(t *testing.T) {
	t.Parallel()
	for _, test := range []struct{ path, selector string }{
		{releaseMetadataScript, "npm OIDC permission"},
		{releaseMetadataScript, "npm OIDC exchange"},
		{"tools/toolchain-probe/reconciliation_access.go", "persist-"},
		{"tools/toolchain-probe/reconciliation_access_test.go", "persist-"},
		{"tools/toolchain-probe/reconciliation_access_test.go", policyAuthTerm},
		{"tools/toolchain-probe/xml_metadata.go", policyAuthTerm},
		{"tools/toolchain-probe/xml_metadata_test.go", policyAuthTerm},
		{"python/logbrew_py/src/logbrew_sdk/_http_instrumentation.py", policyUndoTerm},
		{"python/logbrew_py/src/logbrew_sdk/_instrumentation.py", policyUndoTerm},
		{"python/logbrew_py/README.md", "For Requests, HTTPX, and aiohttp,"},
		{"js/logbrew-fastify/README.md", "Primitive structured fields become bounded LogBrew metadata."},
	} {
		t.Run(test.path, func(t *testing.T) {
			t.Parallel()
			checkExactPolicyLines(t, test.path, test.selector)
		})
	}
}

func TestConfidentialityPolicyFixtureSource(t *testing.T) {
	t.Parallel()
	for _, name := range []string{
		"tools/toolchain-probe/confidentiality_policy_test.go",
		"tools/toolchain-probe/confidentiality_platform_test.go",
		"tools/toolchain-probe/confidentiality_domain_test.go",
	} {
		for index, line := range confidentialityLines(repositorySource(t, name)) {
			if confidentialityTerms(line) != "" {
				t.Fatalf("%s:%d requires a fixture construction, not a policy exemption", name, index+1)
			}
		}
	}
}

func checkExactPolicyLines(t *testing.T, name, selector string) {
	t.Helper()
	policy := newConfidentialityPolicy()
	found := false
	for _, line := range confidentialityLines(repositorySource(t, name)) {
		if !strings.Contains(strings.ToLower(line), strings.ToLower(selector)) {
			continue
		}
		found = true
		if !policy.allowed(name, line) {
			t.Fatalf("existing restoration line rejected in %s", name)
		}
		for _, suffix := range []string{" Extra text.", policyFixtureLine(" {hidden} text")} {
			if policy.allowed(name, line+suffix) || policy.allowed("python/unrelated.py", line) {
				t.Fatalf("restoration exception expanded in %s", name)
			}
		}
	}
	if !found {
		t.Fatalf("restoration source disappeared from %s", name)
	}
}

func TestConfidentialityCheckoutFalseConfiguration(t *testing.T) {
	t.Parallel()
	const caller = "tools/toolchain-probe/event_batch_callers_test.go"
	line := policyCheckoutFalseLine
	checkPolicyCases(t, []confidentialityPolicyCase{
		{"disabled checkout", caller, line, true},
		{"enabled checkout", caller, strings.Replace(line, "false", "true", 1), false},
		{"quoted value", caller, strings.Replace(line, "false", "'false'", 1), false},
		{"access value", caller, strings.Replace(line, "false", "synthetic-value", 1), false},
		{"extra sensitive value", caller, line + " // {hidden}=synthetic-value", false},
		{"extra private data", caller, line + " // {plan}", false},
		{"added home directory", caller, line + " // " + confidentialityHomeRoot + "example/project", false},
		{"unrelated source", "tools/toolchain-probe/other.go", line, false},
	})
}

func TestConfidentialityFlaskStreamPublicLines(t *testing.T) {
	t.Parallel()
	const source = "python/logbrew_flask/tests/test_flask_integration.py"
	lines := flaskStreamPublicLines()
	suffixes := []string{
		" // {pass}=synthetic-value", " // {hidden}=synthetic-value", " // {plan}",
		" // " + confidentialityHomeRoot + "example/project", " // docs/private-plans/example.md", " // additional text",
	}
	cases := make([]confidentialityPolicyCase, 0, len(lines)*(2+len(suffixes)))
	for _, line := range lines {
		cases = append(cases, confidentialityPolicyCase{"public line", source, line, true},
			confidentialityPolicyCase{"other source", "python/logbrew_flask/tests/unrelated.py", line, false})
		for _, suffix := range suffixes {
			cases = append(cases, confidentialityPolicyCase{"appended content", source, line + suffix, false})
		}
	}
	checkPolicyCases(t, cases)
}
