package main

import "golang.org/x/sys/unix"

func renameDirectoryExclusive(parent int, staged, ready string) bool {
	return unix.RenameatxNp(parent, staged, parent, ready, unix.RENAME_EXCL) == nil
}
