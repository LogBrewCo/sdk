package main

import (
	"bytes"
	_ "embed"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/dlclark/regexp2"
)

const (
	confidentialityMode      = "confidentiality-scan"
	confidentialityAllowlist = "tools/toolchain-probe/confidentiality-allowlist.tsv"
	confidentialitySource    = "tools/toolchain-probe/confidentiality_scan.go"
)

//go:embed confidentiality-allowlist.tsv
var confidentialityRules string

var (
	sensitivePattern = regexp2.MustCompile(`(?i)(secret|token|credential|password|private repo|customer|roadmap|`+
		`strategy|runbook|launch state|cleanup|hostnames?|internal path|(?<![A-Za-z0-9])ssh(?![A-Za-z0-9])|`+
		`terraform|dns|backup|restore)`, regexp2.None)
	sensitiveFragments = []string{
		"secret", "token", "credential", "password", "private repo", "customer", "roadmap", "strategy", "runbook",
		"launch state", "cleanup", "hostname", "internal path", "ssh", "terraform", "dns", "backup", "restore",
	}
	readmeForbidden = regexp.MustCompile(`(?i)(real[-_ ]user|smoke|\bproof\b|\bprove\b|` +
		`\bverif(?:y|ied|ier|ication)\b|\btests?\b|\btesting\b|temporary app|temp app|disposable app|fresh app|` +
		`fresh temporary app|package checks?|repository checks?|artifact inspection|ci run|registry mechanics|` +
		`automation agents?|for automation agents|agent-facing)`)
	userHomePath = regexp.MustCompile("(?:/Users/[^/\\s`]+/|/home/[^/\\s`]+/|[A-Za-z]:\\\\Users\\\\[^\\\\\\s`]+\\\\)")
	skippedDirs  = []string{
		".agents", ".git", ".mypy_cache", ".pytest_cache", ".venv", "__pycache__", "build", "dist", "node_modules",
		"target", "vendor",
	}
	skippedExtensions = []string{".gif", ".ico", ".jpg", ".jpeg", ".png", ".webp"}
	planningPaths     = []string{".agents", "CLAUDE.md", "plans", "skills-lock.json"}
	// Python's str.splitlines boundaries, so line numbers stay stable.
	lineBreaks = strings.NewReplacer("\r\n", "\n", "\r", "\n", "\v", "\n", "\f", "\n", "\x1c", "\n", "\x1d", "\n",
		"\x1e", "\n", "\u0085", "\n", " ", "\n", " ", "\n")
)

// allowRule allows one reviewed kind of sensitive-looking line. See the
// allowlist header for the field meanings.
type allowRule struct {
	path    *regexp.Regexp
	terms   []string
	compare string
	kind    string
	text    string
	pattern *regexp.Regexp
}

// checkConfidentiality fails on lines that look like non-public context and
// on public READMEs that describe SDK verification instead of the product.
func checkConfidentiality(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 {
		return writeText(diagnostic, "usage: confidentiality-scan <repository-root>\n", exitUsage)
	}
	rules, err := parseAllowRules(confidentialityRules)
	if err != nil {
		return writeText(diagnostic, err.Error()+"\n", exitFailure)
	}
	failures := confidentialityFailures(arguments[0], rules)
	if len(failures) > 0 {
		if writeText(output, strings.Join(failures, "\n")+"\n", exitOK) != exitOK {
			return exitFailure
		}
		return writeText(diagnostic, "confidentiality scan found unexpected matches\n", exitFailure)
	}
	return writeText(output, "confidentiality scan ok\n", exitOK)
}

func parseAllowRules(data string) ([]allowRule, error) {
	var rules []allowRule
	for number, line := range strings.Split(data, "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		rule, valid := parseAllowRule(line)
		if !valid {
			return nil, errors.New(confidentialityAllowlist + ":" + strconv.Itoa(number+1) + ": invalid rule")
		}
		rules = append(rules, rule)
	}
	return rules, nil
}

func parseAllowRule(line string) (allowRule, bool) {
	fields := strings.Split(line, "\t")
	if len(fields) != 4 || fields[0] == "" || fields[3] == "" {
		return allowRule{}, false
	}
	pathPattern, err := regexp.Compile("^" + globPattern(fields[0]) + "$")
	if err != nil {
		return allowRule{}, false
	}
	rule := allowRule{path: pathPattern, kind: fields[2], text: fields[3]}
	if terms := fields[1]; terms != "*" {
		for _, prefix := range []string{"<=", ">="} {
			if rest, found := strings.CutPrefix(terms, prefix); found {
				rule.compare, terms = prefix, rest
			}
		}
		rule.terms = strings.Split(terms, ",")
		slices.Sort(rule.terms)
	}
	switch rule.kind {
	case "re":
		pattern, err := regexp.Compile(rule.text)
		rule.pattern = pattern
		return rule, err == nil
	case "any", "line", "raw", "prefix", "has", "ihas", "item", "only":
		return rule, true
	}
	return allowRule{}, false
}

// globPattern turns a path glob into a regular expression: "**/" is any
// number of directories, "**" any text, "*" any text within one directory,
// and "{a,b}" either alternative.
func globPattern(glob string) string {
	var pattern strings.Builder
	for index := 0; index < len(glob); index++ {
		switch {
		case strings.HasPrefix(glob[index:], "**/"):
			pattern.WriteString("(?:.*/)?")
			index += 2
		case strings.HasPrefix(glob[index:], "**"):
			pattern.WriteString(".*")
			index++
		case glob[index] == '*':
			pattern.WriteString("[^/]*")
		case glob[index] == '{':
			pattern.WriteString("(?:")
		case glob[index] == '}':
			pattern.WriteString(")")
		case glob[index] == ',' && strings.LastIndex(glob[:index], "{") > strings.LastIndex(glob[:index], "}"):
			pattern.WriteString("|")
		default:
			pattern.WriteString(regexp.QuoteMeta(glob[index : index+1]))
		}
	}
	return pattern.String()
}

func confidentialityFailures(root string, rules []allowRule) []string {
	var failures []string
	for _, planning := range planningPaths {
		if _, err := os.Stat(filepath.Join(root, planning)); err == nil &&
			exec.Command("git", "-C", root, "check-ignore", "--quiet", "--", planning).Run() != nil {
			failures = append(failures, "./"+planning+": forbidden public planning file; keep assistant-local "+
				"plans and task state out of public SDK repos")
		}
	}
	files := scannedFiles(root)
	for _, relative := range files {
		for number, line := range fileLines(root, relative) {
			if failure := lineFailure(relative, line, rules); failure {
				failures = append(failures, "./"+relative+":"+strconv.Itoa(number+1)+":"+line)
			}
		}
	}
	for _, relative := range files {
		if path.Base(relative) != "README.md" {
			continue
		}
		for number, line := range fileLines(root, relative) {
			if readmeForbidden.MatchString(line) {
				failures = append(failures, "./"+relative+":"+strconv.Itoa(number+1)+":public README should describe "+
					"LogBrew service integration, not SDK verification: "+line)
			}
		}
	}
	return failures
}

func lineFailure(relative, line string, rules []allowRule) bool {
	name := path.Base(relative)
	if (name == "AGENTS.md" || name == "AGENTS.override.md") && userHomePath.MatchString(line) {
		return true
	}
	lower := strings.ToLower(line)
	if !slices.ContainsFunc(sensitiveFragments, func(fragment string) bool { return strings.Contains(lower, fragment) }) {
		return false
	}
	terms := sensitiveTerms(line)
	if len(terms) == 0 || (path.Dir(relative) == "assets/brand" && path.Ext(relative) == ".svg") {
		return false
	}
	return !slices.ContainsFunc(rules, func(rule allowRule) bool { return rule.allows(relative, line, terms) })
}

func sensitiveTerms(line string) []string {
	var terms []string
	match, _ := sensitivePattern.FindStringMatch(line)
	for match != nil {
		terms = append(terms, strings.ToLower(match.String()))
		match, _ = sensitivePattern.FindNextMatch(match)
	}
	slices.Sort(terms)
	return slices.Compact(terms)
}

func (rule allowRule) allows(relative, line string, terms []string) bool {
	if !rule.path.MatchString(relative) || !rule.termsMatch(terms) {
		return false
	}
	stripped := strings.TrimSpace(line)
	switch rule.kind {
	case "line":
		return stripped == rule.text
	case "raw":
		return line == rule.text
	case "prefix":
		return strings.HasPrefix(stripped, rule.text)
	case "has":
		return strings.Contains(line, rule.text)
	case "ihas":
		return strings.Contains(strings.ToLower(line), rule.text)
	case "item":
		return strings.Trim(strings.Trim(stripped, ","), `"'`) == rule.text
	case "only":
		return strings.Contains(line, rule.text) && len(sensitiveTerms(strings.ReplaceAll(line, rule.text, ""))) == 0
	case "re":
		return rule.pattern.MatchString(line)
	}
	return true
}

func (rule allowRule) termsMatch(terms []string) bool {
	switch {
	case rule.terms == nil:
		return true
	case rule.compare == "<=":
		return !slices.ContainsFunc(terms, func(term string) bool { return !slices.Contains(rule.terms, term) })
	case rule.compare == ">=":
		return !slices.ContainsFunc(rule.terms, func(term string) bool { return !slices.Contains(terms, term) })
	}
	return slices.Equal(terms, rule.terms)
}

// scannedFiles lists tracked and unignored files, or walks the tree outside a
// Git checkout, in Python path order (directory by directory).
func scannedFiles(root string) []string {
	var files []string
	if listing, err := exec.Command("git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard",
		"-z").Output(); err == nil {
		for _, relative := range strings.Split(string(listing), "\x00") {
			if info, statError := os.Stat(filepath.Join(root, relative)); relative != "" && statError == nil &&
				info.Mode().IsRegular() && scannedPath(relative) {
				files = append(files, relative)
			}
		}
	} else {
		_ = filepath.WalkDir(root, func(current string, entry fs.DirEntry, err error) error {
			if err != nil || current == root {
				return nil
			}
			if entry.IsDir() && (slices.Contains(skippedDirs, entry.Name()) || strings.HasSuffix(entry.Name(), ".egg-info")) {
				return filepath.SkipDir
			}
			relative, _ := filepath.Rel(root, current)
			if !entry.IsDir() && scannedPath(filepath.ToSlash(relative)) {
				files = append(files, filepath.ToSlash(relative))
			}
			return nil
		})
	}
	slices.SortFunc(files, func(left, right string) int {
		return slices.Compare(strings.Split(left, "/"), strings.Split(right, "/"))
	})
	return files
}

func scannedPath(relative string) bool {
	name := path.Base(relative)
	extension := ""
	if dot := strings.LastIndex(name, "."); dot > 0 {
		extension = strings.ToLower(name[dot:])
	}
	return relative != confidentialitySource && relative != confidentialityAllowlist && name != "LICENSE" &&
		!slices.Contains(skippedExtensions, extension) &&
		!slices.ContainsFunc(strings.Split(relative, "/"), func(part string) bool {
			return slices.Contains(skippedDirs, part) || strings.HasSuffix(part, ".egg-info")
		})
}

func fileLines(root, relative string) []string {
	data, _ := os.ReadFile(filepath.Join(root, relative))
	text := lineBreaks.Replace(string(bytes.ToValidUTF8(data, nil)))
	if text == "" {
		return nil
	}
	return strings.Split(strings.TrimSuffix(text, "\n"), "\n")
}
