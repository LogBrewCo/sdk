package main

import (
	"encoding/json"
	"io"
	"regexp"
)

var markdownDocumentLines = regexp.MustCompile(`\r\n|[\n\r\v\f\x{001c}-\x{001e}\x{0085}\x{2028}\x{2029}]`)

type markdownFailure struct {
	source, reason string
	line           int
}

func writeMarkdownFailure(output io.Writer, failure markdownFailure) int {
	document := struct {
		Source string `json:"source"`
		Reason string `json:"reason"`
		Line   int    `json:"line"`
	}{Source: failure.source, Reason: failure.reason, Line: failure.line}
	if err := json.NewEncoder(output).Encode(document); err != nil {
		return exitFailure
	}
	return exitFailure
}
