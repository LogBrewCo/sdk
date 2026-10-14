package main

import (
	"os"
	"path/filepath"
)

func markdownLeafPath(root *os.Root, name string) (string, bool) {
	const maximumLinks = 40
	for range maximumLinks {
		if !filepath.IsLocal(name) {
			return "", false
		}
		info, err := root.Lstat(name)
		if err != nil {
			return "", false
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return name, true
		}
		target, err := root.Readlink(name)
		if err != nil {
			return "", false
		}
		if filepath.IsAbs(target) {
			name, err = filepath.Rel(root.Name(), target)
			if err != nil {
				return "", false
			}
		} else {
			name = filepath.Clean(filepath.Join(filepath.Dir(name), target))
		}
	}
	return "", false
}
