package main

import (
	"path"
	"slices"
	"strings"
	"unicode"
)

const (
	policyRootGuide  = "README.md"
	policyJSGuide    = "js/logbrew-js/README.md"
	policyMemoryPath = "memory.md"
	// Fragments keep detector literals from matching the publication guard themselves.
	confidentialityResearchDir = "docs/" + "competitor" + "-research"
	confidentialityHomeRoot    = "/" + "Users/"
	policyReleaseTest          = "tests/test_release_metadata.py"
	policyCentralAuth          = "central_portal_password"
	policyCentralUser          = "central_portal_username"
	policyCentralPhrase        = "central portal credentials"
	policyUndoTerm             = "restore"
	policyAuthTerm             = "token"
	policyCleanTerm            = "cleanup"
	policyHostTerm             = "hostname"
	policyDNSTerm              = "dns"
	policyDNSConnect           = "dns, connect"
	policyDNSRoute             = "dns/connect"
	policyAppleExcluded        = "isExcludedFromBackup"
	policyQuotedAuth           = `"authtoken",`
	policyQuotedClient         = `"clientsecret",`
	policyQuotedField          = `"credential",`
	policyQuotedFields         = `"credentials",`
	policyQuotedPassword       = `"password",`
	policyQuotedRefresh        = `"refreshtoken",`
	policyQuotedSecret         = `"secret",`
	policyQuotedToken          = `"token",`
	policyPHPAuthFixture       = "'authorization' => 'Bearer " + "lbw_ingest_secret_value',"
	policyPHPURLFixture        = "'endpoint' => 'https://api.example.com/v1/events?token=secret#fragment',"
)

type confidentialityPolicy struct {
	exact, fragments, folded map[string][]string
}

func mergeConfidentialityRules(groups ...map[string][]string) map[string][]string {
	result := make(map[string][]string)
	for _, group := range groups {
		for name, lines := range group {
			result[name] = append(result[name], lines...)
		}
	}
	return result
}

func newConfidentialityPolicy() confidentialityPolicy {
	return confidentialityPolicy{
		exact:     confidentialityExactRules(),
		fragments: confidentialityFragmentRules(),
		folded:    confidentialityFoldedRules(),
	}
}

func (policy confidentialityPolicy) allowed(name, line string) bool {
	if slices.Contains(policy.exact[name], confidentialityTrim(line)) ||
		confidentialityContains(line, policy.fragments[name]) ||
		confidentialityContains(confidentialityLower(line), policy.folded[name]) {
		return true
	}
	terms := confidentialityTerms(line)
	return confidentialityScopedSyntax(name, line, terms) ||
		confidentialityRuntimeScope(name, line, terms) ||
		confidentialityNativeScope(name, line, terms) ||
		confidentialityPublishingScope(name, line, terms)
}

func confidentialityTrim(value string) string {
	return strings.TrimFunc(value, func(character rune) bool {
		return unicode.IsSpace(character) || character >= '\x1c' && character <= '\x1f'
	})
}

func confidentialityContains(line string, fragments []string) bool {
	for _, fragment := range fragments {
		if strings.Contains(line, fragment) {
			return true
		}
	}
	return false
}

func confidentialityExtension(name string, extensions ...string) bool {
	return slices.Contains(extensions, path.Ext(name))
}

func confidentialityScopedSyntax(name, line, terms string) bool {
	if (strings.Contains(name, "angular") || name == "docs/sdk-readiness-checklist.md") &&
		confidentialityContains(line, []string{
			"InjectionToken", "LOG_BREW_ANGULAR_CONTEXT", "injection token", "injection-token",
		}) {
		return true
	}
	if strings.Contains(line, "token=secret") && (strings.HasPrefix(name, "scripts/real_user_") ||
		strings.HasPrefix(name, "js/logbrew-") && strings.HasSuffix(name, "/examples/real-user-smoke.mjs")) {
		return true
	}
	if (strings.HasSuffix(name, ".cs") || strings.HasPrefix(name, "scripts/real_user_")) &&
		confidentialityContains(line, []string{"CancellationToken", "cancellationToken", ".Token"}) {
		return true
	}
	return confidentialityUninstallScope(name, line, terms) || confidentialityDenylistScope(name, line)
}

func confidentialityUninstallScope(name, line, terms string) bool {
	if terms == policyCleanTerm && strings.HasPrefix(name, "scripts/") {
		return true
	}
	if terms == policyUndoTerm {
		if strings.HasPrefix(name, "js/") && confidentialityExtension(name, ".js", ".cjs", ".mjs", ".ts", ".cts") {
			return true
		}
		if strings.HasPrefix(name, "scripts/real_user_") && strings.HasSuffix(name, ".sh") {
			return true
		}
		return slices.Contains([]string{
			"python/logbrew_py/src/logbrew_sdk/_arq_client.py",
			"python/logbrew_py/src/logbrew_sdk/_queue_client.py",
			"python/logbrew_py/src/logbrew_sdk/_rq_client.py",
		}, name) || strings.HasSuffix(name, ".cs") && confidentialityTrim(line) == "#pragma warning restore CA1031"
	}
	if terms == policyCleanTerm && slices.Contains([]string{
		"python/logbrew_py/tests/test_arq_client.py", "python/logbrew_py/tests/test_rq_client.py",
	}, name) {
		return strings.Contains(line, ".addCleanup(")
	}
	return confidentialityExtension(name, ".c", ".h", ".cpp", ".hpp") && strings.Contains(line, "curl_easy_cleanup")
}

func confidentialityDenylistScope(name, line string) bool {
	literal := strings.Trim(strings.Trim(confidentialityTrim(line), ","), "\"'")
	if strings.HasPrefix(name, "python/logbrew_py/src/logbrew_sdk/") && slices.Contains([]string{
		"_cache_client.py", "_celery_client.py", "_db_client.py", "_dbapi_client.py", "_instrumentation.py",
		"_queue_client.py", "_redis_client.py", "_rq_client.py", "_sqlalchemy_client.py",
	}, path.Base(name)) {
		return slices.Contains(strings.Fields(
			"arg bind connection cookie credential dsn header host key param password port payload query "+
				"secret statement token url user value",
		), literal)
	}
	return name == "java/logbrew-java/src/main/java/co/logbrew/sdk/LogBrewJdbcTracing.java" &&
		slices.Contains(strings.Fields(
			"auth authorization connectionstring cookie cookies header headers host hostname "+
				"key param params password query secret sql statement token url username value",
		), literal)
}
