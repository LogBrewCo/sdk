package main

import (
	"slices"
	"strings"
)

func addConfidentialityRules(rules map[string][]string, names, fragments []string) {
	for _, name := range names {
		rules[name] = append(rules[name], fragments...)
	}
}

func confidentialityFragmentRules() map[string][]string {
	rules := map[string][]string{
		"js/logbrew-js/opentelemetry.cjs": {"SENSITIVE_OTEL_ATTRIBUTE_PATTERN"},
		"python/logbrew_py/src/logbrew_sdk/_opentelemetry_processor.py": {
			"SENSITIVE_OTEL_ATTRIBUTE_PATTERN", `r"(^|[._-])(`, `r"private[-_]?key|`,
		},
		"js/logbrew-react-native/README.md":                  {"tokenEnv"},
		"js/logbrew-js/test/release-artifacts-cli.test.js":   {"token=placeholder", "tokenEnv: authEnvName"},
		"scripts/real_user_js_release_artifact_cli_smoke.sh": {"token=placeholder"},
		"tests/test_js_release_artifact_upload.py":           {"?token=ignored"},
		"tests/test_native_release_artifact_upload.py":       {"?token=ignored"},
	}
	addConfidentialityRules(rules, []string{
		"js/logbrew-js/release-artifacts-build.cjs", "js/logbrew-js/release-artifacts-upload.js",
		"js/logbrew-js/vite-release-artifacts.d.cts", "js/logbrew-js/vite-release-artifacts.d.ts",
		"js/logbrew-next/release-artifacts.d.cts", "js/logbrew-next/release-artifacts.d.ts",
		"js/logbrew-react-native/release-artifacts.cjs", "js/logbrew-react-native/release-artifacts.d.cts",
		"js/logbrew-react-native/release-artifacts.d.ts", "scripts/release_artifact_upload_common.py",
		"scripts/upload_js_release_artifacts.py", "scripts/upload_native_release_artifacts.py",
	}, []string{
		"DEFAULT_UPLOAD_TOKEN_ENV", "DEFAULT_TOKEN_ENV", "parsed.hostname", "parsed.username", "parsed.password",
		"parsedEndpoint.username", "parsedEndpoint.password", "const hostname =", "hostname =", "hostname ===",
		"net.isIP(hostname)", "requireLoopbackUploadEndpoint", "isLoopbackUploadEndpoint", "if not hostname:",
		"must include a hostname", "hostname.lower()", "token: str", "Bearer ${token}", "Bearer {token}",
		`"token-env": "string"`, "--token-env", "release-artifact token", "tokenEnv", "const tokenEnv",
		"tokenEnv?: string", "if (tokenEnv", "const token =", "token = os.environ.get", "if (!token)",
		"if not token:", "auth: { tokenEnv }", "token=token", "endpoint, token, body", "token,",
		"Authorization:", "Authorization", "postMultipart", "post_multipart",
	})
	addConfidentialityRules(rules, []string{
		"scripts/real_user_js_release_artifact_upload_smoke.sh",
		"scripts/real_user_native_release_artifact_upload_smoke.sh",
		"scripts/real_user_next_release_artifact_smoke.sh", "scripts/real_user_react_native_release_artifact_smoke.sh",
		"scripts/real_user_vite_release_artifact_smoke.sh",
	}, []string{
		"expected_token", "LOGBREW_RELEASE_ARTIFACT_TOKEN", "containsToken", "wrong-token",
		"--token-env LOGBREW_RELEASE_ARTIFACT_TOKEN_BAD",
	})
	return rules
}

func confidentialityFoldedRules() map[string][]string {
	rules := map[string][]string{
		githubActionsDocPath: {"long-lived registry tokens"},
		".github/publishing/trusted-publishers.md": {
			"after adding packagist secrets", "rubygems/configure-rubygems-credentials", "nuget_user",
			"release environment secret", "packagist_username", "packagist_api_token", policyCentralAuth,
			"environment secrets", "maven central signing", policyCentralPhrase, "signing keys",
			"trusted publishing", "trusted publisher",
		},
		policyReleaseTest: {
			workflowOIDCWrite, npmExchangePath, "maven central user-token credential hint",
			"maven central generated credential hint", "central portal user-token credentials",
			"generated central portal publishing credentials", "central portal publishing credentials",
			policyCentralPhrase,
		},
		releaseMetadataScript: {
			`"maven central user-token credential hint": "central portal user-token credentials"`,
			`"maven central generated credential hint": "generated central portal publishing credentials"`,
		},
		"tests/test_affected_family_release_prep.py": {"npm_config_to", `"/-/npm/v1/oidc/" "token/exchange/package/"`},
		"scripts/check_maven_central_auth_preflight.sh": {
			policyCentralUser, policyCentralAuth, "generated central portal publishing values",
		},
		"tests/test_maven_central_auth_preflight.py": {
			policyCentralUser, policyCentralAuth, "secret_values", "generated_token_hint",
			"requires_secret_env_names", "user-token", "secret-token",
		},
		"scripts/real_user_php_smoke.sh": {
			"support ticket", "supportdraft", "token-free", "account/session api credentials",
		},
		"ruby/logbrew-ruby/README.md": {`runtimeerror.new("hidden token")`},
	}
	addConfidentialityRules(rules, []string{
		publishWorkflowPath, "tools/npm-publish/publish.mjs",
	}, []string{
		"actions_id_token_request_url", "actions_id_token_request_token", npmExchangePath,
		"typeof exchange.token", "return exchange.token", "token: grants[index]",
		"central portal user-token credentials",
		"generated central portal publishing credentials", "central portal publishing credentials",
		"generated central portal publishing values",
	})
	addConfidentialityRules(rules, []string{
		policyReleaseTest,
	}, []string{
		policyCentralUser, policyCentralAuth, "user-token", "secret-token", "secret names only", "secret_names_only",
	})
	return mergeConfidentialityRules(rules, confidentialitySupportDocs())
}

func confidentialitySupportDocs() map[string][]string {
	rules := make(map[string][]string)
	addConfidentialityRules(rules, []string{
		"go/logbrew/README.md", "java/logbrew-java/README.md", policyJSGuide,
		"js/logbrew-js/index.d.cts", "js/logbrew-js/index.d.ts", policyMemoryPath, "dotnet/logbrew-dotnet/README.md",
		"php/logbrew-php/README.md", "python/logbrew_py/README.md", "ruby/logbrew-ruby/README.md",
		"scripts/real_user_js_smoke.sh", "scripts/real_user_python_smoke.sh",
	}, []string{
		"support-ticket", "support ticket", "support routes", "account/session api credentials",
		"diagnostic", "redact", "token-free",
	})
	return rules
}

func confidentialityPublishingScope(name, line, terms string) bool {
	if strings.HasPrefix(name, ".github/workflows/") && confidentialityWorkflowPlaceholder(confidentialityLower(line)) {
		return true
	}
	if name == "js/logbrew-js/release-artifacts.js" &&
		strings.Contains(line, "upload-js") && strings.Contains(line, "--token-env") {
		return true
	}
	if name == policyJSGuide && strings.Contains(line, "--token-env LOGBREW_RELEASE_ARTIFACT_AUTH") {
		return true
	}
	if slices.Contains([]string{
		"docs/backend-contracts/release-artifact-symbolication-2026-06-13.md",
		policyJSGuide, "js/logbrew-next/README.md",
	}, name) {
		lower := confidentialityLower(line)
		if strings.Contains(lower, "upload") && strings.Contains(lower, "artifact") {
			return true
		}
	}
	return confidentialityDotnetRelease(name, line, terms)
}

func confidentialityWorkflowPlaceholder(lower string) bool {
	return confidentialityContains(lower, []string{
		workflowOIDCWrite, "persist-credentials: false", "cargo_registry_token",
		"configure rubygems trusted publishing credentials", "rubygems/configure-rubygems-credentials",
		"secrets.nuget_user", "packagist_username: ${{ secrets.packagist_username }}",
		"packagist_api_token: ${{ secrets.packagist_api_token }}",
		"packagist_username:?set packagist_username",
		"packagist_api_token:?set packagist_api_token", "packagist_api_token:-", "apitoken=${packagist_api_token}",
		policyCentralPhrase, "maven_gpg_private_key: ${{ secrets.maven_gpg_private_key }}",
		"maven_gpg_passphrase: ${{ secrets.maven_gpg_passphrase }}",
		"maven_gpg_key_id: ${{ secrets.maven_gpg_key_id }}",
		"central_portal_username: ${{ secrets.central_portal_username }}",
		"central_portal_password: ${{ secrets.central_portal_password }}",
		"central_portal_username:?set central_portal_username", "central_portal_password:?set central_portal_password",
		"os.environ['central_portal_password']", "signing keys", "gh_token: ${{ github.token }}",
		"github_authorization: ${{ github.token }}", "github-token: ${{ github.token }}",
	})
}

func confidentialityDotnetRelease(name, line, terms string) bool {
	if terms == policyUndoTerm && slices.Contains([]string{
		".github/workflows/publish-nuget.yml", policyReleaseTest,
	}, name) {
		const project = "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj"
		return strings.Contains(line, "dotnet restore "+project) ||
			strings.Contains(line, "dotnet pack "+project+" --no-restore")
	}
	if terms != policyAuthTerm {
		return false
	}
	if name == "scripts/real_user_dotnet_httpclient_package_compatibility_smoke.sh" {
		return strings.Contains(line, "PublicKeyToken") || confidentialityTrim(line) ==
			`return token == null || token.Length == 0 ? "unsigned" : Convert.ToHexString(token).ToLowerInvariant();`
	}
	return name == "tests/test_dotnet_httpclient_package_compatibility_smoke.py" &&
		strings.Contains(line, `"GetPublicKeyToken"`)
}
