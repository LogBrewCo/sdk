package main

import (
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

const markdownLinksMode = "markdown-links"

var (
	markdownLink    = regexp.MustCompile(`\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)
	markdownHeading = regexp.MustCompile(`^#{1,6}\s+(.+?)\s*#*\s*$`)
	markdownTag     = regexp.MustCompile(`<[^>]+>`)
	markdownCode    = regexp.MustCompile("`([^`]*)`")
	ignoredParts    = []string{
		".git", ".gradle", ".pytest_cache", ".ruff_cache", "bin", "build", "dist",
		"node_modules", "obj", "target", "vendor",
	}
	externalSchemes = []string{"http://", "https://", "mailto:", "tel:"}
)

// checkMarkdownLinks fails when a local Markdown link names a missing file, a
// missing heading anchor, or a path outside the repository.
func checkMarkdownLinks(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 {
		return writeText(diagnostic, "usage: markdown-links <repository-root>\n", exitUsage)
	}
	failures := markdownLinkFailures(arguments[0])
	if len(failures) > 0 {
		return writeText(diagnostic, strings.Join(failures, "\n")+"\n", exitFailure)
	}
	return writeText(output, "markdown links ok\n", exitOK)
}

func markdownLinkFailures(root string) []string {
	root, err := filepath.Abs(root)
	if err == nil {
		root, err = filepath.EvalSymlinks(root)
	}
	if err != nil {
		return []string{"repository root is unavailable"}
	}
	files := markdownFiles(root)
	if len(files) == 0 {
		return []string{"no Markdown files found"}
	}
	var failures []string
	anchors := map[string]map[string]bool{}
	for _, file := range files {
		data, err := os.ReadFile(file)
		relative, _ := filepath.Rel(root, file)
		if err != nil || !utf8.Valid(data) {
			failures = append(failures, relative+": unreadable or not UTF-8")
			continue
		}
		for number, line := range strings.Split(string(data), "\n") {
			for _, match := range markdownLink.FindAllStringSubmatchIndex(line, -1) {
				if match[0] > 0 && line[match[0]-1] == '!' {
					continue
				}
				target := line[match[2]:match[3]]
				if problem := linkProblem(root, file, target, anchors); problem != "" {
					failures = append(failures, fmt.Sprintf("%s:%d: %s", relative, number+1, problem))
				}
			}
		}
	}
	return failures
}

func markdownFiles(root string) []string {
	var files []string
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		switch {
		case err != nil:
			return nil
		case entry.IsDir() && path != root && slices.Contains(ignoredParts, entry.Name()):
			return filepath.SkipDir
		case !entry.IsDir() && strings.HasSuffix(entry.Name(), ".md"):
			files = append(files, path)
		}
		return nil
	})
	return files
}

func linkProblem(root, file, target string, anchors map[string]map[string]bool) string {
	lowered := strings.ToLower(target)
	for _, scheme := range externalSchemes {
		if strings.HasPrefix(lowered, scheme) {
			return ""
		}
	}
	pathText, anchor, hasAnchor := strings.Cut(target, "#")
	pathText, anchor = unescapeLink(pathText), unescapeLink(anchor)
	resolved := file
	if pathText != "" {
		resolved = filepath.Join(filepath.Dir(file), pathText)
	}
	if real, err := filepath.EvalSymlinks(resolved); err == nil {
		resolved = real
	}
	if relative, err := filepath.Rel(root, resolved); err != nil || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "link leaves repository: " + target
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "missing link target: " + target
	}
	if !hasAnchor || anchor == "" || info.IsDir() || !strings.EqualFold(filepath.Ext(resolved), ".md") {
		return ""
	}
	if anchors[resolved] == nil {
		anchors[resolved] = headingAnchors(resolved)
	}
	if !anchors[resolved][anchor] {
		relative, _ := filepath.Rel(root, resolved)
		return fmt.Sprintf("missing heading anchor #%s in %s", anchor, relative)
	}
	return ""
}

func unescapeLink(text string) string {
	if unescaped, err := url.PathUnescape(text); err == nil {
		return unescaped
	}
	return text
}

// headingAnchors returns GitHub's anchors for a file's headings, numbering repeats.
func headingAnchors(path string) map[string]bool {
	anchors := map[string]bool{}
	counts := map[string]int{}
	data, _ := os.ReadFile(path)
	for _, line := range strings.Split(string(data), "\n") {
		match := markdownHeading.FindStringSubmatch(strings.TrimSuffix(line, "\r"))
		if match == nil {
			continue
		}
		base := githubAnchor(match[1])
		if base == "" {
			continue
		}
		if count := counts[base]; count > 0 {
			anchors[fmt.Sprintf("%s-%d", base, count)] = true
		} else {
			anchors[base] = true
		}
		counts[base]++
	}
	return anchors
}

func githubAnchor(heading string) string {
	text := markdownCode.ReplaceAllString(markdownTag.ReplaceAllString(strings.ToLower(strings.TrimSpace(heading)), ""), "$1")
	text = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || r == '-' || unicode.IsSpace(r) {
			return r
		}
		return -1
	}, text)
	return strings.Join(strings.Fields(text), "-")
}
