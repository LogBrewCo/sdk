package main

import (
	"os"
	"reflect"
	"testing"
)

func TestReleaseMetadataAggregation(t *testing.T) {
	t.Parallel()
	var visited []string
	checks := map[string]func(*os.Root) bool{}
	for _, family := range []string{"z", "a", "m"} {
		checks[family] = func(_ *os.Root) bool {
			visited = append(visited, family)
			return true
		}
	}
	if !checkAllReleaseMetadata(nil, checks) || !reflect.DeepEqual(visited, []string{"a", "m", "z"}) {
		t.Fatal("aggregate did not check every family in deterministic order")
	}
	checks["m"] = func(_ *os.Root) bool { return false }
	if checkAllReleaseMetadata(nil, checks) {
		t.Fatal("aggregate accepted failed family")
	}
	checks["m"] = nil
	if checkAllReleaseMetadata(nil, checks) || checkAllReleaseMetadata(nil, nil) {
		t.Fatal("aggregate accepted missing policy")
	}
}
