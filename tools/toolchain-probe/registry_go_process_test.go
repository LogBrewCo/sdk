package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegistryGoProcessInit(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	arguments := []string{registryGoMod, registryGoInit, registryGoConsumerModule}
	if !registryGoProcess(context.Background(), directory, arguments) {
		t.Fatal("local Go mod init failed")
	}
	//nolint:gosec // G304: path is the test-owned temporary consumer manifest.
	data, err := os.ReadFile(filepath.Join(directory, goMetadataManifest))
	if err != nil || !strings.Contains(string(data), "module "+registryGoConsumerModule) {
		t.Fatal("consumer module identity missing")
	}
}

func TestRegistryGoProcessBoundary(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if verifyRegistryGo(ctx, registryDefaultVersion) {
		t.Fatal("cancelled verification accepted")
	}
	if registryGoProcess(ctx, t.TempDir(), []string{registryGoMod, registryGoInit, registryGoConsumerModule}) {
		t.Fatal("cancelled process accepted")
	}
	for _, args := range [][]string{
		nil,
		{"env"},
		{registryGoGet, "other/module@v1"},
		{registryGoGet, goMetadataModule + "@v"},
		{registryGoMod, registryGoInit, "other-consumer-module"},
	} {
		if registryGoProcess(context.Background(), t.TempDir(), args) {
			t.Fatalf("accepted %v", args)
		}
	}
}
