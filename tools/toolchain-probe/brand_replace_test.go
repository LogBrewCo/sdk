package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBrandReplaceRejectsNonregular(t *testing.T) {
	t.Parallel()
	const name = "assets/brand/app-icon-256.png"
	root := openMarkdownFixture(t, map[string]string{
		"assets/brand/replacement-note.txt": "replacement boundary fixture",
	})
	outside := filepath.Join(t.TempDir(), "preserved.png")
	const mode = 0o600
	if err := os.WriteFile(outside, []byte("preserved outside fixture"), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root.Name(), name)); err != nil {
		t.Fatal(err)
	}
	if brandReplaceFile(root, name, []byte("attempted replacement")) {
		t.Fatal("symlink target replaced")
	}
	info, err := root.Lstat(name)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("rejected symlink was altered")
	}
	if err := root.Remove(name); err != nil {
		t.Fatal(err)
	}
	const directoryMode = 0o700
	if err := root.Mkdir(name, directoryMode); err != nil {
		t.Fatal(err)
	}
	if brandReplaceFile(root, name, []byte("attempted replacement")) {
		t.Fatal("directory target replaced")
	}
}

func TestBrandReplaceFile(t *testing.T) {
	t.Parallel()
	const name = "assets/brand/app-icon-256.png"
	root := openMarkdownFixture(t, map[string]string{name: "previous generated fixture"})
	if !brandReplaceFile(root, name, []byte("replacement generated fixture")) {
		t.Fatal("generated file replacement failed")
	}
	data, valid := brandReadAsset(root, name, brandSVGByteLimit)
	if !valid || string(data) != "replacement generated fixture" {
		t.Fatal("generated file replacement readback changed")
	}
	if brandReplaceFile(root, brandCanonicalSource, []byte("canonical mutation")) ||
		brandReplaceFile(root, name, nil) {
		t.Fatal("invalid generated replacement accepted")
	}
}
