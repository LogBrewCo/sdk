package main

import (
	"errors"
	"io"
	"os"
	"path"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

const ciWorkflowDirectory = ".github/workflows"

var ciWorkflowLineBreak = regexp.MustCompile(`\r\n|[\n\r\v\f\x1c-\x1e\x{0085}\x{2028}\x{2029}]`)

type ciStaticFinding struct {
	Source string `json:"source"`
	Line   int    `json:"line"`
}

type ciStaticInventory struct {
	findings []ciStaticFinding
	complete bool
}

func ciStaticFiles(root *os.Root, entryLimit int) ([]string, bool) {
	directory, err := root.Open(ciWorkflowDirectory)
	if err != nil {
		return nil, false
	}
	entries, readError := directory.ReadDir(entryLimit + 1)
	closeError := directory.Close()
	if readError != nil && !errors.Is(readError, io.EOF) || closeError != nil || len(entries) > entryLimit {
		return nil, false
	}
	var files []string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".yml") || strings.HasSuffix(entry.Name(), ".yaml") {
			files = append(files, path.Join(ciWorkflowDirectory, entry.Name()))
		}
	}
	slices.Sort(files)
	return files, len(files) > 0
}

func ciStaticWorkflowInventory(root *os.Root, entryLimit, byteLimit int) ciStaticInventory {
	result := ciStaticInventory{findings: nil, complete: false}
	files, valid := ciStaticFiles(root, entryLimit)
	if !valid {
		return result
	}
	for _, file := range files {
		data, readable := readReleaseMetadata(root, file)
		if !readable || !utf8.Valid(data) || len(data) > byteLimit {
			return result
		}
		byteLimit -= len(data)
		for index, line := range ciWorkflowLineBreak.Split(string(data), -1) {
			if ciStaticCommandPresent(line) {
				result.findings = append(result.findings, ciStaticFinding{Source: file, Line: index + 1})
			}
		}
	}
	result.complete = true
	return result
}
