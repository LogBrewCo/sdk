package main

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

var ciLocalStaticCommand = regexp.MustCompile(`(?i)(` +
	`scripts/check_(?:js_lint|shell_static|python_static|go_static|java_static|php_static|` +
	`swift_style|kotlin_style)\.sh` +
	`|npm\s+run\s+lint|pnpm\s+(?:run\s+)?lint|yarn\s+lint` +
	`|eslint\b|ruff\s+check\b|mypy\b|shellcheck\b|staticcheck\b|go\s+vet\b|gofmt\b` +
	`|cargo\s+fmt\b|cargo\s+clippy\b|swiftformat\b|swiftlint\b|ktlint\b|rubocop\b|phpstan\b)`)

func ciStaticCommandPresent(line string) bool {
	line = strings.Map(ciStaticRune, line)
	for _, match := range ciLocalStaticCommand.FindAllStringIndex(line, -1) {
		before, _ := utf8.DecodeLastRuneInString(line[:match[0]])
		if backendWordCharacter(before) {
			continue
		}
		command := strings.ToLower(line[match[0]:match[1]])
		if ciStaticOpenSuffix(command) {
			return true
		}
		after, _ := utf8.DecodeRuneInString(line[match[1]:])
		if !backendWordCharacter(after) {
			return true
		}
	}
	return false
}

func ciStaticOpenSuffix(command string) bool {
	for _, prefix := range []string{"scripts/", "npm ", "pnpm ", "yarn "} {
		if strings.HasPrefix(command, prefix) {
			return true
		}
	}
	return false
}

func ciStaticRune(value rune) rune {
	if markdownWhitespace(value) {
		return ' '
	}
	return backendCaseRune(value)
}
