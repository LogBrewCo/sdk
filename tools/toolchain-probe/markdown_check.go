package main

import (
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

type markdownCheck struct {
	anchors   map[string]map[string]bool
	root      *os.Root
	failure   markdownFailure
	remaining int
}

func checkMarkdownLinks(root *os.Root) bool {
	return markdownLinksFailure(root).reason == ""
}

func markdownLinksFailure(root *os.Root) markdownFailure {
	files, valid := markdownFiles(root)
	if !valid {
		return markdownFailure{source: "", reason: "invalid-inventory", line: 0}
	}
	check := markdownCheck{
		anchors: make(map[string]map[string]bool), root: root,
		failure: markdownFailure{source: "", reason: "", line: 0}, remaining: markdownByteLimit,
	}
	for _, name := range files {
		if !check.document(name) {
			return check.failure
		}
	}
	return check.failure
}

func (check *markdownCheck) read(name string) (string, bool) {
	resolved, valid := markdownLeafPath(check.root, name)
	if !valid {
		return "", false
	}
	data, readable := readReleaseMetadata(check.root, resolved)
	if !readable || len(data) > check.remaining || !utf8.Valid(data) {
		return "", false
	}
	check.remaining -= len(data)
	return string(data), true
}

func (check *markdownCheck) document(name string) bool {
	document, readable := check.read(name)
	if !readable {
		check.failure = markdownFailure{source: name, reason: "document-unreadable", line: 0}
		return false
	}
	check.anchors[name] = markdownAnchors(document)
	for index, line := range markdownDocumentLines.Split(document, -1) {
		for _, target := range markdownLocalTargets(line) {
			if reason := check.targetReason(name, target); reason != "" {
				check.failure = markdownFailure{source: name, reason: reason, line: index + 1}
				return false
			}
		}
	}
	return true
}

func (check *markdownCheck) targetReason(source string, target markdownTarget) string {
	name, inside := markdownTargetPath(check.root, source, target.path)
	if !inside {
		return "target-outside-repository"
	}
	resolved, valid := markdownLeafPath(check.root, name)
	if !valid {
		return "target-unavailable"
	}
	info, err := check.root.Stat(resolved)
	if err != nil {
		return "target-unavailable"
	}
	if target.anchor == "" || !info.Mode().IsRegular() || !strings.EqualFold(filepath.Ext(name), ".md") {
		return ""
	}
	anchors, cached := check.anchors[name]
	if !cached {
		document, readable := check.read(name)
		if !readable {
			return "target-unreadable"
		}
		anchors = markdownAnchors(document)
		check.anchors[name] = anchors
	}
	if !anchors[target.anchor] {
		return "anchor-missing"
	}
	return ""
}

func markdownTargetPath(root *os.Root, source, target string) (string, bool) {
	name := source
	if target != "" {
		if filepath.IsAbs(target) {
			var err error
			name, err = filepath.Rel(root.Name(), target)
			if err != nil {
				return "", false
			}
		} else {
			name = filepath.Clean(filepath.Join(filepath.Dir(source), target))
		}
	}
	return name, filepath.IsLocal(name)
}
