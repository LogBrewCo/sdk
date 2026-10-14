package main

import (
	"net/url"
	"regexp"
	"strings"
)

const markdownSpacePattern = `\s\p{Z}\x{0085}\x{001c}-\x{001f}`

var markdownInlineLink = regexp.MustCompile(`\[[^\]]+\]\(([^)` + markdownSpacePattern +
	`]+)(?:[` + markdownSpacePattern + `]+"[^"]*")?\)`)

type markdownTarget struct {
	path, anchor string
}

func markdownLocalTargets(line string) []markdownTarget {
	var targets []markdownTarget
	for _, match := range markdownInlineLink.FindAllStringSubmatchIndex(line, -1) {
		if match[0] > 0 && line[match[0]-1] == '!' {
			continue
		}
		raw := strings.TrimSpace(line[match[2]:match[3]])
		if markdownExternal(raw) {
			continue
		}
		path, anchor, _ := strings.Cut(raw, "#")
		targets = append(targets, markdownTarget{path: markdownUnquote(path), anchor: markdownUnquote(anchor)})
	}
	return targets
}

func markdownExternal(target string) bool {
	target = strings.ToLower(target)
	for _, prefix := range []string{"http://", "https://", "mailto:", "tel:"} {
		if strings.HasPrefix(target, prefix) {
			return true
		}
	}
	return false
}

// Preserve malformed percent escapes, matching the predecessor's unquote behavior.
func markdownUnquote(value string) string {
	var decoded []byte
	for index := 0; index < len(value); index++ {
		if value[index] == '%' && index+2 < len(value) {
			if text, err := url.PathUnescape(value[index : index+3]); err == nil {
				decoded = append(decoded, text...)
				index += 2
				continue
			}
		}
		decoded = append(decoded, value[index])
	}
	return markdownReplacementUTF8(decoded)
}
