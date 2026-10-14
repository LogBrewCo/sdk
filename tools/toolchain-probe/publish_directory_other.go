//go:build !darwin && !linux

package main

func renameDirectoryExclusive(_ int, _, _ string) bool { return false }
