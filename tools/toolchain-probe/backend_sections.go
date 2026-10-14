package main

import (
	"regexp"
	"strings"
)

const backendSectionLevel = 2

var backendReportHeading = regexp.MustCompile(`(?m)^(#{1,6})[\t\n\x0b\x0c\r\x1c-\x1f ` +
	`\x{0085}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}]+([^\n]+)`)

func backendReportSections(document string) map[string]string {
	matches := backendReportHeading.FindAllStringSubmatchIndex(document, -1)
	sections := make(map[string]string)
	for index, match := range matches {
		level := match[3] - match[2]
		if level != backendSectionLevel {
			continue
		}
		end := len(document)
		for _, next := range matches[index+1:] {
			if next[3]-next[2] <= level {
				end = next[0]
				break
			}
		}
		title := strings.TrimFunc(document[match[4]:match[5]], markdownWhitespace)
		sections[title] = strings.TrimFunc(document[match[1]:end], markdownWhitespace)
	}
	return sections
}
