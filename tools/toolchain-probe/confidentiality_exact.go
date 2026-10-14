package main

const policyCheckoutFalseLine = `"ref: ${{ github.workflow_sha }}", "persist-credentials: false",`

func confidentialityExactRules() map[string][]string {
	return mergeConfidentialityRules(map[string][]string{
		"tools/toolchain-probe/event_batch_callers_test.go":    {policyCheckoutFalseLine},
		"python/logbrew_flask/tests/test_flask_integration.py": flaskStreamPublicLines(),
		releaseMetadataScript: {
			`"npm OIDC permission": "id-token: write",`,
			`"npm OIDC exchange": "/-/npm/v1/oidc/token/exchange/package/",`,
		},
		githubActionsDocPath: {
			"group during cleanup, including children left behind after command exit.",
		},
		"tests/test_check_public_sdks.py": {"self.addCleanup(temporary.cleanup)"},
		"tools/toolchain-probe/main.go":   {`return "cleanup failed"`},
		"python/logbrew_py/src/logbrew_sdk/_http_instrumentation.py": {
			"self._restore_request = _instrumentation.patch_instance_attributes(", "self._restore_request()",
		},
		"python/logbrew_py/src/logbrew_sdk/_instrumentation.py": {
			`"""Restore original attributes only while this patch still owns them."""`,
			"def restore() -> None:", "return restore",
		},
		"python/logbrew_py/README.md": {
			"For Requests, HTTPX, and aiohttp, `uninstall()` restores the original method only if " +
				"LogBrew's wrapper is still installed. If your application replaces that method afterward, " +
				"removal preserves the replacement. Uninstall and reinstall instrumentation to capture " +
				"calls through the new method.",
		},
		"java/logbrew-java/src/main/java/co/logbrew/sdk/PersistenceCrypto.java": {
			"import javax.crypto.spec.SecretKeySpec;", `new SecretKeySpec(key, "AES"),`,
		},
		"go/logbrew/gin/README.md": {"values and drops keys that suggest credentials, payloads, URLs, headers,"},
		"go/logbrew/gin/middleware.go": {
			"// credentials, payloads, URLs, headers, queries, or raw propagation are",
			`"host", "hostname", "ipaddress", "key", "message", "params", "parameters", "password", "path",`,
			`"payload", "query", "remoteaddress", "secret", "sql", "stack", "statement", "token",`,
		},
		"go/logbrew/gin/middleware_test.go": {
			`"https://private.example.test/articles/private-article?token=private-query-value",`,
			`request := httptest.NewRequest(http.MethodGet, "/profiles/private-user?token=private", nil)`,
			`for _, unsafe := range append([]string{"private-user", "token=private", ` +
				`"traceparent"}, testCase.headers...) {`,
			`request := httptest.NewRequest(http.MethodGet, "/panic/private-id?token=private", nil)`,
			`for _, unsafe := range []string{"private panic value", "private-id", ` +
				`"token=private", "Bearer private", "Authorization"} {`,
		},
		"scripts/real_user_go_gin_smoke.sh": {
			`"https://private.example.test/articles/private-article?token=private-query",`,
			`httptest.NewRequest(http.MethodGet, "/panic/private-id?token=private-panic-query", nil),`,
		},
		"scripts/real_user_ruby_rails_smoke.sh": {
			`config.secret_key_base = "installed-rails-smoke-secret-key-base"`,
		},
		publishWorkflowPath: {"secrets: inherit"},
		"dotnet/logbrew-dotnet/src/LogBrew/DurableStoreFileSystem.cs": {
			"private const uint WindowsShareRead = 1;", "private const uint WindowsShareWrite = 2;",
			"private const uint WindowsShareDelete = 4;", "private const uint WindowsBackupSemantics = 0x02000000;",
			"WindowsShareRead | WindowsShareDelete,", "WindowsShareRead | (allowDelete ? WindowsShareDelete : 0),",
			"WindowsShareRead | WindowsShareWrite,", "return WindowsShareRead",
			"| (allowDelete ? WindowsShareDelete : 0)", "| (allowWrite ? WindowsShareWrite : 0);",
			"WindowsBackupSemantics | WindowsOpenReparsePoint,",
		},
	}, confidentialitySupportExact(), confidentialityPinoExact(), confidentialityNativeExact())
}

func confidentialityPinoExact() map[string][]string {
	return map[string][]string{
		policyRootGuide: {
			"- Automatic Pino metadata excludes credentials, cookies, bodies, payloads, query text, raw URLs, " +
				"propagation headers, local file paths, and stack text by default.",
		},
		"js/logbrew-fastify/README.md": {
			`redact: ["authorization", "cookie", "password", "token"]`,
			"Primitive structured fields become bounded LogBrew metadata. Credentials, cookies, bodies, " +
				"payloads, query fields, raw URLs, propagation headers, local file paths, and stack text are " +
				"excluded automatically. Keep normal Pino redaction enabled because " +
				"the log message itself is telemetry.",
		},
		"js/logbrew-js/core.cjs": {
			policyQuotedFields, policyQuotedPassword, policyQuotedSecret, policyQuotedToken,
			`|| normalized.endsWith("credentials")`, `|| normalized.endsWith("password")`,
			`|| normalized.endsWith("secret")`, `|| normalized.endsWith("token")`,
		},
		"js/logbrew-js/test/sdk.test.js": {`requestUrl: "/checkout/42?token=hidden",`},
		"js/logbrew-node/README.md": {
			`redact: ["authorization", "cookie", "password", "token"]`,
			"Primitive structured fields become `context.*` metadata. " +
				"Runtime defaults and nested objects are omitted. " +
				"Credentials, authorization and cookie fields, bodies, payloads, query fields, raw URLs, propagation " +
				"headers, local file paths, and stack fields are also excluded automatically; serialized error " +
				"name/message remain available, while stack text requires `includeErrorStack: true`. The log message " +
				"itself is telemetry, so keep secrets and user-entered text out of messages and retain your normal " +
				"Pino redaction policy.",
		},
		"js/logbrew-node/test/pino-instrumentation.test.js": {
			`hostname: "host.local",`, `requestUrl: "/checkout/42?token=hidden",`,
		},
		"scripts/real_user_fastify_smoke.sh": {
			`requestUrl: "/auto?token=hidden",`, `nested: { token: "hidden" }`,
			`if (JSON.stringify(pinoPayload).includes("Bearer hidden") || ` +
				`JSON.stringify(pinoPayload).includes("token=hidden")) {`,
		},
	}
}

func confidentialityNativeExact() map[string][]string {
	return mergeConfidentialityRules(confidentialityNativeTestExact(), map[string][]string{
		"tools/toolchain-probe/publication_npm.go": {
			`npmExchangePath  = "/-/npm/v1/oidc/token/exchange/package/"`,
			`return yamlScalar(yamlField(permissions, "id-token"), yamlStringTag, "write") &&`,
		},
		"tools/toolchain-probe/reconciliation_access.go": {
			`if !yamlScalar(yamlField(inputs, "persist-credentials"), yamlBooleanTag, "false") {`,
			`allowed := append([]string{"persist-credentials"}, extra...)`,
			`return yamlField(step, "with", "persist-credentials")`,
		},
		"tools/toolchain-probe/reconciliation_access_test.go": {
			`"persist-credentials: false":           "persist-credentials: true # persist-credentials: false",`,
			`"with:\n          ref:":                "with:\n          token: custom\n          ref:",`,
		},
		"tools/toolchain-probe/xml_metadata_test.go": {
			`const directive = "//nolint:gosec,nolintlint // G709: bounded token parser; ` +
				`unstable finding documented above."`,
		},
		"tools/toolchain-probe/xml_metadata.go": {
			"// Reviewed 2026-09-12: bounded UTF-8 token parsing, no object deserialization.",
			"//nolint:gosec,nolintlint // G709: bounded token parser; unstable finding documented above.",
			"token, err := decoder.Token()",
			"if err != nil || !parser.consume(token) {",
			"func (parser *metadataXMLParser) consume(token xml.Token) bool {",
			"switch value := token.(type) {",
		},
		"tools/toolchain-probe/json_document.go": {
			"value, err := decoder.Token()",
			"closing, closeError := decoder.Token()",
			"token, err := decoder.Token()",
			"key, isString := token.(string)",
			"closing, err := decoder.Token()",
		},
		"tools/toolchain-probe/main.go": {
			"errProcessCleanup      = errors.New(\"cleanup failed\")",
			"case errors.Is(err, errUnsupportedPlatform), errors.Is(err, errProcessCleanup):",
			"return errProcessCleanup",
		},
		"tools/toolchain-probe/python_consumer.go": {
			"failure = \"temporary directory cleanup\"",
			"//nolint:gosec // G204: deadline, child cleanup, output and file bounds have executable tests.",
		},
		"tools/toolchain-probe/python_smoke.go": {
			"failure = \"temporary directory cleanup\"",
		},
	})
}

func confidentialityNativeTestExact() map[string][]string {
	rules := map[string][]string{
		"tools/toolchain-probe/python_consumer_test.go": {
			`name: "smoke", arguments: nil, checks: []pythonOutputCheck{check}, forbidden: []string{"secret-marker"},`,
			"{`secret-marker`, `{\"events\":4}`, false},",
			"{emptyDocument, \"secret-marker\\n{\\\"events\\\":4}\", false},",
		},
		"tools/toolchain-probe/python_public_http_test.go": {
			"t.Fatal(\"registry response failed closed-state or body cleanup checks\")",
		},
		"tools/toolchain-probe/python_public_test.go": {
			"prefix + filename + \"?token=example\", prefix + filename + \"#fragment\",",
		},
		"tools/toolchain-probe/python_smoke_binding_test.go": {
			"t.Fatal(\"binding lost its worker limit, joined cleanup, exact request set, or complete result\")",
		},
		"tools/toolchain-probe/release_workflow_test.go": {
			"if strings.Count(job, \"persist-credentials: false\") < 2 {",
		},
		// Reviewed 2026-10-03: public permission vocabulary used only to reject publishing.
		// NativeExactReferences binds the exact source line, rejects suffixes and other paths.
		"tools/toolchain-probe/reconciliation_access.go": {
			`workflowOIDCWrite          = "id-token: write"`,
		},
		"tools/toolchain-probe/python_workflow_test.go": {
			`"persist-credentials: false", nativeProbeInvocation+" publication-run",`,
			`"id-token: write", "environment: release", "gh-action-pypi-publish", "dotnet nuget push", "nuget/login",`,
		},
	}
	for _, name := range []string{
		"tools/toolchain-probe/publish_directory_test.go", "tools/toolchain-probe/python_bytecode_test.go",
		"tools/toolchain-probe/python_sdist_normalize_test.go",
		"tools/toolchain-probe/markdown_check_test.go",
	} {
		rules[name] = []string{"t.Cleanup(func() {"}
	}
	rules["tools/toolchain-probe/github_gate_test.go"] = []string{
		`yamlScalar(yamlField(step, "env", "GH_TOKEN"), yamlStringTag, "${{ github.token }}")`,
	}
	rules["tools/toolchain-probe/generated_gate_test.go"] = []string{"cleanup_build_artifacts"}
	rules["tools/toolchain-probe/publication_workflow.go"] = []string{
		`yamlStringTag, "${{ github.token }}") &&`,
	}
	return rules
}

func flaskStreamPublicLines() []string {
	return []string{
		"self.addCleanup(logger.removeHandler, handler)",
		"self.addCleanup(logger.setLevel, logger.level)",
		"self.addCleanup(response.close)",
		"self.addCleanup(builder.close)",
		"self.addCleanup(first.close)",
		"self.addCleanup(second.close)",
	}
}
