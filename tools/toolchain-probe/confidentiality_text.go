package main

import (
	"iter"
	"path"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	confidentialityKeywords = "secret|token|credential|password|private repo|customer|roadmap|strategy|" +
		"runbook|launch state|cleanup|hostname|internal path|ssh|terraform|dns|backup|restore"
	confidentialitySSH    = "ssh"
	confidentialitySpaces = `\s\v\x1c-\x1f\x{0085}\p{Z}`
)

var (
	confidentialitySensitive = regexp.MustCompile("(?i)" + strings.ReplaceAll(
		strings.ReplaceAll(confidentialityKeywords, "hostname", "hostnames?"), "i", "[iİı]",
	))
	confidentialityREADME = regexp.MustCompile("(?i)" + strings.ReplaceAll(
		`real[-_ ]user|smoke|proof|prove|verif(?:ication|ied|ier|y)|testing|tests?|`+
			`(?:temporary|temp|disposable|fresh(?: temporary)?) app|package checks?|`+
			`repository checks?|artifact inspection|ci run|registry mechanics|automation agents?|`+
			`for automation agents|agent-facing`, "i", "[iİı]",
	))
	confidentialityUserHome = regexp.MustCompile(
		"(?:" + confidentialityHomeRoot + "[^/" + confidentialitySpaces + "`]+/|/home/[^/" + confidentialitySpaces +
			"`]+/|[A-Za-z]:\\\\Users\\\\[^\\\\" + confidentialitySpaces + "`]+\\\\)",
	)
)

// Python's case-insensitive ASCII letter ranges include both dotted and dotless
// I. Keep that existing policy without lookaround or backtracking expressions.
func confidentialityCaseLetters(value rune) rune {
	switch value {
	case 'İ', 'ı':
		return 'i'
	case 'ſ':
		return 's'
	default:
		return unicode.ToLower(value)
	}
}

func confidentialityLower(text string) string {
	return strings.ToLower(strings.ReplaceAll(text, "İ", "i\u0307"))
}

func confidentialityTerms(line string) string {
	lower := confidentialityLower(line)
	present := false
	for keyword := range strings.SplitSeq(confidentialityKeywords, "|") {
		if strings.Contains(lower, keyword) {
			present = true
			break
		}
	}
	if !present {
		return ""
	}
	terms := make([]string, 0)
	for _, match := range confidentialitySensitive.FindAllStringIndex(line, -1) {
		term := confidentialityLower(line[match[0]:match[1]])
		if strings.Map(confidentialityCaseLetters, term) == confidentialitySSH &&
			!confidentialityBoundaries(line, match, confidentialityASCIIWord) {
			continue
		}
		terms = append(terms, term)
	}
	slices.Sort(terms)
	return strings.Join(slices.Compact(terms), "|")
}

func confidentialityASCIIWord(value rune) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' ||
		value >= '0' && value <= '9' || value == 'İ' || value == 'ı' || value == 'ſ' || value == 'K'
}

func confidentialityUnicodeWord(value rune) bool {
	return value == '_' || unicode.IsLetter(value) || unicode.IsNumber(value)
}

func confidentialityBoundaries(line string, match []int, word func(rune) bool) bool {
	before, _ := utf8.DecodeLastRuneInString(line[:match[0]])
	after, _ := utf8.DecodeRuneInString(line[match[1]:])
	return (match[0] == 0 || !word(before)) && (match[1] == len(line) || !word(after))
}

func confidentialityREADMEForbidden(line string) bool {
	for _, match := range confidentialityREADME.FindAllStringIndex(line, -1) {
		term := strings.Map(confidentialityCaseLetters, line[match[0]:match[1]])
		wholeWord := slices.Contains([]string{
			"proof", "prove", "verify", "verified", "verifier", "verification", "test", "tests", "testing",
		}, term)
		if !wholeWord || confidentialityBoundaries(line, match, confidentialityUnicodeWord) {
			return true
		}
	}
	return false
}

func confidentialityHomePath(name, line string) bool {
	base := path.Base(name)
	return (base == "AGENTS.md" || base == "AGENTS.override.md") && confidentialityUserHome.MatchString(line)
}

func confidentialityLines(content string) []string {
	return slices.Collect(confidentialityLineSeq(content))
}

func confidentialityLineSeq(content string) iter.Seq[string] {
	return func(yield func(string) bool) {
		start := 0
		for end, value := range content {
			if !strings.ContainsRune("\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029", value) {
				continue
			}
			if value == '\n' && end > 0 && content[end-1] == '\r' {
				start = end + 1
				continue
			}
			if !yield(content[start:end]) {
				return
			}
			start = end + utf8.RuneLen(value)
		}
		if start < len(content) {
			yield(content[start:])
		}
	}
}
