package main

import (
	"io"
	"strings"
	"testing"
)

func TestGoMetadataSelectedRootMutations(t *testing.T) {
	t.Parallel()
	policy := goMetadataPolicy()
	files := make(map[string]string)
	for _, path := range policy.files {
		files[policy.prefix+path] = ""
	}
	for path := range policy.patterns {
		files[policy.prefix+path] = repositorySource(t, policy.prefix+path)
	}
	for path := range policy.patterns {
		for _, replacement := range [][2]string{
			{goMetadataModule, "github.com/unknown/sdk"},
			{"go 1.24.0", "go 1.23.0"},
			{"v0.1.", "v9.9."},
			{"v1.41.0", "v9.41.0"},
			{"v1.11.0", "v9.11.0"},
			{"v0.26.0", "v9.26.0"},
		} {
			name := policy.prefix + path
			original := files[name]
			changed := strings.ReplaceAll(original, replacement[0], replacement[1])
			if changed == original {
				continue
			}
			files[name] = changed
			root := confidentialityFixture(t, files)
			if runReleaseMetadata([]string{"go", root}, io.Discard, io.Discard) == exitOK {
				t.Errorf("altered Go metadata accepted in %s: %s", path, replacement[0])
			}
			files[name] = original
		}
	}
}
