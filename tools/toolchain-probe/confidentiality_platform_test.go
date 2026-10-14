package main

import (
	"slices"
	"strings"
	"testing"
)

func TestConfidentialityArchiveSymbols(t *testing.T) {
	t.Parallel()
	policy := newConfidentialityPolicy()
	for _, test := range []struct{ path, line string }{
		{
			"js/logbrew-react-native/android/src/main/java/co/logbrew/reactnative/FatalStoreModuleImpl.java",
			"File root = context.getNo{archiveTitle}FilesDir();",
		},
		{
			"js/logbrew-react-native/ios/LBRNFatalStoreModule.mm",
			"[url setResourceValue:@YES forKey:NSURLIsExcludedFrom{archiveTitle}Key error:nil];",
		},
		{
			"swift/logbrew-swift/Sources/LogBrewCrash/CrashStorageDirectory.swift",
			"values.isExcludedFrom{archiveTitle} = true",
		},
		{
			"swift/logbrew-swift/Tests/LogBrewCrashTests/NativeHangIncidentStoreTests.swift",
			"#expect(values.isExcludedFrom{archiveTitle} == true)",
		},
		{
			"js/logbrew-react-native/ios/GeneratedAppleDiagnostics/LogBrewCrash/CrashStorageDirectory.swift",
			"values.isExcludedFrom{archiveTitle} = true",
		},
	} {
		line := policyFixtureLine(test.line)
		if !policy.allowed(test.path, line) || policy.allowed("Other.java", line) ||
			policy.allowed(test.path, line+policyFixtureLine(" // arbitrary {archive} language")) ||
			policy.allowed(test.path, line+policyFixtureLine(" // {hidden}")) {
			t.Fatalf("archive exclusion scope changed for %s", test.path)
		}
	}
}

func TestConfidentialityQueueOwnership(t *testing.T) {
	t.Parallel()
	policy := newConfidentialityPolicy()
	for _, test := range []struct{ path, line string }{
		{"python/logbrew_py/src/logbrew_sdk/_arq_client.py", policyQueueUndo},
		{"python/logbrew_py/src/logbrew_sdk/_queue_client.py", policyQueueUndo},
		{"python/logbrew_py/src/logbrew_sdk/_rq_client.py", policyQueueUndo},
		{"python/logbrew_py/tests/test_arq_client.py", policyQueueTeardown},
		{"python/logbrew_py/tests/test_rq_client.py", policyQueueTeardown},
		{"docs/github-actions.md", "group during {clean}, including children left behind after command exit."},
		{"tests/test_check_public_sdks.py", "self.add{cleanTitle}(temporary.{clean})"},
		{"tools/toolchain-probe/main.go", `return "{clean} failed"`},
	} {
		line := policyFixtureLine(test.line)
		if !policy.allowed(test.path, line) || policy.allowed("python/unrelated.py", line) ||
			policy.allowed(test.path, line+policyFixtureLine(" arbitrary {hidden} text")) {
			t.Fatalf("queue control scope changed for %s", test.path)
		}
	}
}

func TestConfidentialityGinScope(t *testing.T) {
	t.Parallel()
	const path = "go/logbrew/gin/middleware_test.go"
	line := policyFixtureLine(
		`request := httptest.NewRequest(http.MethodGet, "/profiles/private-user?{auth}=private", nil)`,
	)
	policy := newConfidentialityPolicy()
	if !policy.allowed(path, line) || policy.allowed(path, line+" // extra") ||
		policy.allowed("go/logbrew/gin/unrelated.go", line) {
		t.Fatal("Gin exact-line ownership changed")
	}
}

func TestConfidentialityDotnetCompatibility(t *testing.T) {
	t.Parallel()
	const (
		project = "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj"
		script  = "scripts/real_user_dotnet_httpclient_package_compatibility_smoke.sh"
	)
	checkPolicyCases(t, []confidentialityPolicyCase{
		{"dependency fetch", ".github/workflows/publish-nuget.yml", "dotnet {undo} " + project, true},
		{"package", ".github/workflows/publish-nuget.yml", "dotnet pack " + project + " --no-{undo}", true},
		{"assembly identity", script, "GetPublicKey{authTitle}()", true},
		{
			"assembly identity conversion", script,
			`return {auth} == null || {auth}.Length == 0 ? "unsigned" : ` +
				"Convert.ToHexString({auth}).ToLowerInvariant();", true,
		},
		{
			"assembly identity fixture", "tests/test_dotnet_httpclient_package_compatibility_smoke.py",
			`"GetPublicKey{authTitle}"`, true,
		},
		{"unrelated identity", "dotnet/Other.cs", "GetPublicKey{authTitle}()", false},
	})
}

func TestConfidentialityDenylistFields(t *testing.T) {
	t.Parallel()
	policy := newConfidentialityPolicy()
	for name := range strings.FieldsSeq(
		"_cache_client.py _celery_client.py _db_client.py _dbapi_client.py _instrumentation.py " +
			"_queue_client.py _redis_client.py _rq_client.py _sqlalchemy_client.py",
	) {
		for _, field := range []string{"{auth}", "{hidden}", "{pass}"} {
			line := policyFixtureLine(`"` + field + `",`)
			path := "python/logbrew_py/src/logbrew_sdk/" + name
			if !policy.allowed(path, line) || policy.allowed(path, line+" # extra") ||
				policy.allowed("python/unrelated.py", line) {
				t.Fatalf("literal vocabulary scope changed for %s", path)
			}
		}
	}
}

func TestConfidentialityAppleDurableScope(t *testing.T) {
	t.Parallel()
	policy := newConfidentialityPolicy()
	for _, name := range []string{
		"objc/logbrew-objc/README.md",
		"objc/logbrew-objc/src/LBWDurableDeliveryStore.m",
		"objc/logbrew-objc/tests/test_durable_delivery.m",
		"objc/logbrew-objc/tests/test_durable_delivery_recovery.m",
		"swift/logbrew-swift/README.md",
		"swift/logbrew-swift/Sources/LogBrew/DurableDeliveryStoreRecovery.swift",
		"swift/logbrew-swift/Tests/LogBrewTests/DurableDeliveryPublicContractTests.swift",
		"js/logbrew-react-native/ios/GeneratedAppleDiagnostics/LogBrew/DurableDeliveryStoreRecovery.swift",
	} {
		line := policyFixtureLine("exclude durable files from {archive} and {clean} invalid records")
		if !policy.allowed(name, line) || policy.allowed("swift/DeliveryEngine.swift", line) ||
			policy.allowed(name, line+policyFixtureLine(" {hidden}")) {
			t.Fatalf("durable-file scope changed for %s", name)
		}
	}
}

func TestConfidentialityCrashEngineScope(t *testing.T) {
	t.Parallel()
	policy := newConfidentialityPolicy()
	for _, name := range []string{
		"swift/logbrew-swift/Sources/LogBrewCrash/CrashEngine.swift",
		"js/logbrew-react-native/ios/GeneratedAppleDiagnostics/LogBrewCrash/CrashEngine.swift",
	} {
		line := policyFixtureLine("configuration.report{cleanTitle}Policy = .never")
		if !policy.allowed(name, line) || policy.allowed("swift/Other.swift", line) ||
			policy.allowed(name, line+policyFixtureLine(" {hidden}")) {
			t.Fatalf("crash-engine symbol scope changed for %s", name)
		}
	}
	checkPolicyCases(t, []confidentialityPolicyCase{
		{
			"apple endpoint guard",
			"js/logbrew-react-native/ios/AppleDiagnostics/LBRNAppleNativeDiagnostics.swift",
			"components.{pass} == nil,", true,
		},
	})
}

func TestConfidentialityMavenAuthReferences(t *testing.T) {
	t.Parallel()
	const (
		script   = "scripts/check_maven_central_auth_preflight.sh"
		testFile = "tests/test_maven_central_auth_preflight.py"
	)
	checkPolicyCases(t, []confidentialityPolicyCase{
		{"user reference", publishWorkflowPath, "{centralUser}: ${{ {hidden}s.{centralUser} }}", true},
		{"auth reference", publishWorkflowPath, "{centralPass}: ${{ {hidden}s.{centralPass} }}", true},
		{"shell reference", script, "${{centralPass}:-}", true},
		{"environment user", script, "os.environ['{centralUser}']", true},
		{"environment auth", script, "os.environ['{centralPass}']", true},
		{"public guidance", script, "generated Central Portal publishing values", true},
		{"auth fixture", testFile, `"{centralPass}": {pass}`, true},
		{"user fixture", testFile, `"fixture-user-{auth}"`, true},
		{"opaque fixture", testFile, `"fixture-{hidden}-{auth}"`, true},
		{"unrelated auth", "scripts/unrelated.sh", "{centralPass}", false},
	})
}

func TestConfidentialityNativeExactReferences(t *testing.T) {
	t.Parallel()
	policy := newConfidentialityPolicy()
	for name, lines := range confidentialityNativeExact() {
		source := confidentialityLines(repositorySource(t, name))
		for _, line := range lines {
			present := slices.ContainsFunc(source, func(candidate string) bool {
				return confidentialityTrim(candidate) == line
			})
			if !present || !policy.allowed(name, line) || policy.allowed(name, line+" // extra") ||
				policy.allowed("tools/toolchain-probe/unrelated.go", line) {
				t.Fatalf("native vocabulary has a stale or expanded exemption in %s", name)
			}
		}
	}
}
