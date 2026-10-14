package main

import "testing"

func TestCILocalStaticCommands(t *testing.T) {
	t.Parallel()
	for _, command := range []string{
		"bash scripts/check_shell_static.sh", "npm run lint", "pnpm lint", "pnpm run lint", "yarn lint",
		"eslint js", "ruff check python", "mypy src", "shellcheck script.sh", "staticcheck ./...", "go vet ./...",
		"gofmt file.go", "cargo fmt", "cargo clippy", "swiftformat src", "swiftlint", "ktlint", "rubocop", "phpstan",
	} {
		if !ciStaticCommandPresent(command) {
			t.Fatalf("local-only static command accepted in CI: %q", command)
		}
	}
	for _, command := range []string{
		"bash scripts/check_js_package.sh", "bash scripts/real_user_js_smoke.sh", "go test ./...",
		"eslintish", "prefixmypy", "ruff format python",
	} {
		if ciStaticCommandPresent(command) {
			t.Fatalf("unrelated CI command rejected: %q", command)
		}
	}
}

func TestCIStaticUnicodeAndSuffixParity(t *testing.T) {
	t.Parallel()
	for _, command := range []string{
		"npm\u00a0run\u2003lint", "go\x1cvet", "MYPY src", "npm run lintmore",
		"bash scripts/check_shell_static.sh.more", "pnpm\t\trun lint-extra",
	} {
		if !ciStaticCommandPresent(command) {
			t.Fatalf("predecessor static command missed: %q", command)
		}
	}
	for _, command := range []string{"émypy", "mypyé", "go vet²", "prefixnpm run lint"} {
		if ciStaticCommandPresent(command) {
			t.Fatalf("Unicode embedded command rejected: %q", command)
		}
	}
}
