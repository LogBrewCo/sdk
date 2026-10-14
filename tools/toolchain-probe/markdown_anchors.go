package main

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var markdownHTMLTag = regexp.MustCompile(`<[^>]+>`)

func markdownAnchor(text string) string {
	text = markdownHTMLTag.ReplaceAllString(strings.ToLower(strings.TrimSpace(text)), "")
	var clean []rune
	for _, value := range text {
		if value == '_' || value == '-' || unicode.IsLetter(value) || unicode.IsNumber(value) ||
			markdownWhitespace(value) {
			clean = append(clean, value)
		}
	}
	return strings.Join(strings.FieldsFunc(string(clean), markdownWhitespace), "-")
}

func markdownWhitespace(value rune) bool {
	return unicode.IsSpace(value) || value >= '\x1c' && value <= '\x1f'
}

func markdownHeading(line string) string {
	const maximumLevel = 6
	level := 0
	for level < len(line) && line[level] == '#' {
		level++
	}
	separator, _ := utf8.DecodeRuneInString(line[level:])
	if level == 0 || level > maximumLevel || level == len(line) || !markdownWhitespace(separator) {
		return ""
	}
	return strings.TrimSpace(strings.TrimRight(strings.TrimSpace(line[level:]), "#"))
}

func markdownAnchors(document string) map[string]bool {
	counts := make(map[string]int)
	anchors := make(map[string]bool)
	for _, line := range strings.FieldsFunc(document, registryLineSeparator) {
		base := markdownAnchor(markdownHeading(line))
		if base == "" {
			continue
		}
		anchor := base
		if counts[base] > 0 {
			anchor += "-" + strconv.Itoa(counts[base])
		}
		anchors[anchor] = true
		counts[base]++
	}
	return anchors
}
