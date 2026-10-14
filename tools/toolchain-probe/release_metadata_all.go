package main

import (
	"maps"
	"os"
	"slices"
)

func checkAllReleaseMetadata(root *os.Root, checks map[string]func(*os.Root) bool) bool {
	if len(checks) == 0 {
		return false
	}
	for _, family := range slices.Sorted(maps.Keys(checks)) {
		check := checks[family]
		if check == nil || !check(root) {
			return false
		}
	}
	return true
}
