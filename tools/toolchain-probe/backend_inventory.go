package main

import (
	"errors"
	"io"
	"os"
	"path"
	"slices"
	"strings"
	"unicode/utf8"
)

const backendReportDirectory = "docs/backend-contracts"

type backendReportFailure struct {
	source string
	reason string
}

type backendReportInventory struct {
	failures []backendReportFailure
	complete bool
}

func backendReports(root *os.Root, fileLimit, byteLimit int) backendReportInventory {
	result := backendReportInventory{failures: nil, complete: false}
	directory, err := root.Open(backendReportDirectory)
	if err != nil {
		return result
	}
	entries, readError := directory.ReadDir(fileLimit + 1)
	closeError := directory.Close()
	if readError != nil && !errors.Is(readError, io.EOF) || closeError != nil || len(entries) > fileLimit {
		return result
	}
	var names []string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".md") {
			names = append(names, path.Join(backendReportDirectory, entry.Name()))
		}
	}
	if len(names) == 0 {
		return result
	}
	slices.Sort(names)
	for _, name := range names {
		data, valid := readReleaseMetadata(root, name)
		if !valid || !utf8.Valid(data) || len(data) > byteLimit {
			return result
		}
		byteLimit -= len(data)
		for _, reason := range backendReportFailures(string(data)) {
			result.failures = append(result.failures, backendReportFailure{source: name, reason: reason})
		}
	}
	result.complete = true
	return result
}
