package main

import (
	"bytes"
	"io"
	"path/filepath"
	"testing"
)

func brandSuccessJSON() string {
	return "{\"passed\":true}\n"
}

func TestBrandCommandRepository(t *testing.T) {
	t.Parallel()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if runBrandAssets([]string{root}, &output, io.Discard) != exitOK ||
		output.String() != brandSuccessJSON() {
		t.Fatal("current brand repository command failed")
	}
	if runBrandAssets([]string{root}, rejectedCheckOutput{}, io.Discard) != exitFailure {
		t.Fatal("brand receipt output failure passed")
	}
}

func TestBrandCommandInvalidInputs(t *testing.T) {
	t.Parallel()
	for _, arguments := range [][]string{nil, {"relative-brand-repository"}, {t.TempDir(), t.TempDir()}} {
		var output, diagnostic bytes.Buffer
		if runBrandAssets(arguments, &output, &diagnostic) != exitUsage || output.Len() != 0 {
			t.Fatal("invalid brand arguments accepted")
		}
	}
	var output, diagnostic bytes.Buffer
	if runBrandAssets([]string{filepath.Join(t.TempDir(), "missing")}, &output, &diagnostic) != exitFailure {
		t.Fatal("missing repository accepted")
	}
	output.Reset()
	if runBrandAssets([]string{t.TempDir()}, &output, &diagnostic) != exitFailure ||
		output.String() != "{\"passed\":false}\n" {
		t.Fatal("incomplete brand repository claimed success")
	}
}
