package main

import (
	"math"
	"os"
	"path/filepath"
	"strings"
)

// Both names are direct children of the caller's already-open parent.
// The platform operation must reject an existing destination atomically.
func publishDirectory(root *os.Root, staged, ready string) bool {
	if !directDirectoryName(staged) || !directDirectoryName(ready) || staged == ready {
		return false
	}
	info, err := root.Lstat(staged)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	parent, err := root.Open(".")
	if err != nil {
		return false
	}
	published := false
	if descriptor := parent.Fd(); descriptor <= math.MaxInt32 {
		published = renameDirectoryExclusive(int(descriptor), staged, ready)
	}
	closeError := parent.Close()
	return published && closeError == nil
}

func directDirectoryName(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name &&
		!strings.ContainsAny(name, "\\\x00")
}
