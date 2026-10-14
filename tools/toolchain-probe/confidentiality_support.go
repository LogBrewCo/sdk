package main

func confidentialitySupportExact() map[string][]string {
	return mergeConfidentialityRules(confidentialitySupportFixtures(), map[string][]string{
		"js/logbrew-js/support-ticket.cjs": {
			policyQuotedAuth, policyQuotedClient, policyQuotedField, policyQuotedPassword,
			policyQuotedRefresh, policyQuotedSecret, `"token"`,
			`return /(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\s*[:=]/iu.test(value)`,
		},
		"go/logbrew/support_ticket.go": {
			`"authtoken":        {},`, `"clientsecret":     {},`, `"credential":       {},`, `"credentials":      {},`,
			`"password":         {},`, `"refreshtoken":     {},`, `"secret":           {},`, `"token":            {},`,
			policyQuotedField, policyQuotedPassword, policyQuotedSecret, policyQuotedToken,
			"supportSensitiveAssignmentPattern = regexp.MustCompile(`(?i)(?:authorization|api[_-]?key|token|secret|" +
				"password|passwd|cookie)\\s*[:=]`)",
			"supportTokenPattern               = regexp.MustCompile(`(?i)(?:\\bBearer\\s+[A-Za-z0-9._~+/=-]+|" +
				"\\blbw_ingest_[A-Za-z0-9._-]+|\\b(?:sk|pk|xox[abprs]?)-[A-Za-z0-9_-]{10,}|\\bAKIA[0-9A-Z]{16}\\b)`)",
			"// CreateSupportTicketDraft builds a local-only, token-free support-ticket",
			"if supportSensitiveAssignmentPattern.MatchString(value) || supportTokenPattern.MatchString(value) {",
		},
		"java/logbrew-java/src/main/java/co/logbrew/sdk/SupportTicketDraft.java": {
			"* credentials.</p>", policyQuotedAuth, policyQuotedClient, policyQuotedField, policyQuotedFields,
			policyQuotedPassword, policyQuotedRefresh, policyQuotedSecret, `"token"`,
			`"(?i)(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\s*[:=]"`,
			"private static final Pattern TOKEN_PATTERN = Pattern.compile(",
			"if (SENSITIVE_ASSIGNMENT_PATTERN.matcher(value).find() || TOKEN_PATTERN.matcher(value).find()) {",
		},
		"dotnet/logbrew-dotnet/src/LogBrew/SupportTicketDraft.cs": {"/// account/session API credentials."},
		"dotnet/logbrew-dotnet/src/LogBrew/SupportDiagnosticsSanitizer.cs": {
			policyQuotedAuth, policyQuotedClient, policyQuotedField, policyQuotedFields, policyQuotedPassword,
			policyQuotedRefresh, policyQuotedSecret, policyQuotedToken,
			`"(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\s*[:=]",`,
			"private static readonly Regex TokenPattern = new Regex(",
			"if (SensitiveAssignmentPattern.IsMatch(value) || TokenPattern.IsMatch(value))",
		},
		"python/logbrew_py/src/logbrew_sdk/_support_ticket.py": {
			policyQuotedAuth, policyQuotedClient, policyQuotedField, policyQuotedFields, policyQuotedPassword,
			policyQuotedRefresh, policyQuotedSecret, "_SENSITIVE_KEY_MARKERS = (",
			policyQuotedToken, "_TOKEN_PATTERN = re.compile(",
			`"Build a local-only, token-free support-ticket create payload draft without calling backend routes."`,
			`r"(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\s*[:=]",`,
			"if _SENSITIVE_ASSIGNMENT_PATTERN.search(value) or _TOKEN_PATTERN.search(value):",
			"return normalized in _SENSITIVE_KEYS or any(marker in normalized for marker in _SENSITIVE_KEY_MARKERS)",
		},
		"js/logbrew-js/test/sdk.test.js": {`{ token: "hidden" }`, `{ token: "[redacted]" }`},
		"go/logbrew/support_ticket_test.go": {
			`map[string]any{"token": "hidden"},`,
			`if len(events) != 2 || events[1].(map[string]any)["token"] != "[redacted]" {`,
		},
		"java/logbrew-java/src/test/java/co/logbrew/sdk/SupportTicketDraftTest.java": {
			`secondEvent.put("token", "hidden");`,
			`assertEquals("[redacted]", safeSecondEvent.get("token"), "event token");`,
		},
		"dotnet/logbrew-dotnet/tests/LogBrew.Tests/SupportTicketDraftTests.cs": {
			`new Dictionary<string, object?> { ["token"] = "hidden" }`,
			`Require((string)secondEvent["token"]! == "[redacted]", "expected nested token redaction");`,
		},
		"python/logbrew_py/tests/test_support_ticket.py": {
			`"access_token": "hidden",`, `"access_token": "[redacted]",`, `"api_key": "hidden",`,
			`"api_key": "[redacted]",`, `"cookie_header": "cookie=hidden",`, `"cookie_header": "[redacted]",`,
			`"events": [{"token": "hidden"}, {"ok": True}],`, `"events": [{"token": "[redacted]"}, {"ok": True}],`,
		},
	})
}

func confidentialitySupportFixtures() map[string][]string {
	return map[string][]string{
		"scripts/real_user_go_support_ticket_smoke.sh": {
			`token := strings.Join([]string{"lbw", "ingest", "hidden"}, "_")`, `"apiKey":      token,`,
		},
		"php/logbrew-php/src/SupportTicketDraft.php": {
			"'authtoken',", "'clientsecret',", "'credential',", "'credentials',", "'password',",
			"'refreshtoken',", "'secret',", "'token',",
			`return preg_match('/(?:authorization|api[_-]?key|token|secret|password|` +
				`passwd|cookie)\s*[:=]/i', $value) === 1`,
			`|| preg_match('/\blbw_(?:ingest|client|api)_[A-Za-z0-9._-]+/i', $value) === 1;`,
		},
		"php/logbrew-php/tests/support_ticket.php": {
			policyPHPAuthFixture,
			policyPHPURLFixture,
			"'debugNote' => 'failed at https://api.example.com/v1/events?token=secret " +
				"from " + confidentialityHomeRoot + "example/project/.env',",
			"'cookie' => 'session=secret',", "'tokenText' => 'token=secret',",
			"'lbw_ingest_secret_value',", "'token=secret',",
			"assertTrue(($supportNested['tokenText'] ?? null) === '[redacted]', " +
				"'expected support draft nested token text redaction');",
		},
		"php/logbrew-php/examples/real_user_smoke.php": {
			policyPHPAuthFixture,
			policyPHPURLFixture,
		},
		"scripts/real_user_php_smoke.sh": {
			policyPHPAuthFixture,
			policyPHPURLFixture,
			"'debugNote' => 'failed at https://api.example.com/v1/events?token=secret " +
				"from " + confidentialityHomeRoot + "example/project/.env',",
			"'lbw_ingest_secret_value',", "'token=secret',",
		},
		"ruby/logbrew-ruby/lib/logbrew/support_ticket.rb": {
			"authtoken", "clientsecret", "credential", "password", "refreshtoken", "secret", policyAuthTerm,
			`value.match?(/(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\s*[:=]/i) ||`,
		},
		"ruby/logbrew-ruby/examples/real_user_smoke.rb": {`error: RuntimeError.new("contains hidden token")`},
		"ruby/logbrew-ruby/tests/run.rb": {
			`exception_message: "password leaked in snake case message",`,
			`error: RuntimeError.new("contains hidden token"),`, `{ token: "hidden" }`,
			`assert(events[1].fetch("token") == "[redacted]", "expected support nested token redaction")`,
		},
		"scripts/real_user_ruby_smoke.sh": {`error: RuntimeError.new("hidden token"),`},
	}
}
