package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestBrandWriteOutputs(t *testing.T) {
	t.Parallel()
	const preserved = "assets/brand/writer-note.txt"
	const marker = "preserved writer fixture"
	root := openMarkdownFixture(t, map[string]string{preserved: marker, brandCanonicalSource: marker})
	outputs := brandWriterFixture(t)
	if !brandWriteOutputs(root, outputs) {
		t.Fatal("complete generated output write failed")
	}
	for name, expected := range outputs {
		actual, valid := brandReadAsset(root, name, brandSVGByteLimit)
		if !valid || !bytes.Equal(actual, expected) {
			t.Fatal("generated output readback changed")
		}
	}
	for _, name := range []string{preserved, brandCanonicalSource} {
		actual, valid := brandReadAsset(root, name, brandSVGByteLimit)
		if !valid || string(actual) != marker {
			t.Fatal("nongenerated file changed")
		}
	}
	if !brandWriteOutputs(root, outputs) || brandWriteOutputs(root, nil) {
		t.Fatal("repeat or incomplete write contract changed")
	}
}

func TestBrandWritePreflightPreservesFiles(t *testing.T) {
	t.Parallel()
	const preserved = "assets/brand/app-icon-256.png"
	const marker = "unchanged preflight fixture"
	root := openMarkdownFixture(t, map[string]string{preserved: marker})
	const directoryMode = 0o700
	if err := root.Mkdir("assets/brand/logbrew-logo-transparent-1600.svg", directoryMode); err != nil {
		t.Fatal("nonregular output fixture unavailable")
	}
	if brandWriteOutputs(root, brandWriterFixture(t)) {
		t.Fatal("nonregular output target accepted")
	}
	actual, valid := brandReadAsset(root, preserved, brandSVGByteLimit)
	if !valid || string(actual) != marker {
		t.Fatal("preflight failure changed earlier output")
	}
}

func brandWriterFixture(t *testing.T) map[string][]byte {
	t.Helper()
	outputs := make(map[string][]byte)
	for name := range brandGeneratedAssets() {
		outputs[name] = []byte(repositorySource(t, name))
	}
	return outputs
}

func TestBrandWriteRejectsLinkedDirectory(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{"assets/write-boundary.txt": "directory boundary fixture"})
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root.Name(), brandAssetDirectory)); err != nil {
		t.Fatal("linked output directory fixture unavailable")
	}
	if brandWriteOutputs(root, brandWriterFixture(t)) {
		t.Fatal("linked output directory accepted")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("rejected linked directory changed")
	}
}
