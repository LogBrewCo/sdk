package main

import "golang.org/x/sys/unix"

func renameDirectoryExclusive(parent int, staged, ready string) bool {
	return unix.Renameat2(parent, staged, parent, ready, unix.RENAME_NOREPLACE) == nil
}
