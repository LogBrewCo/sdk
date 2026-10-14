package main

import (
	"crypto/rand"
	"io"
	"os"
	"path/filepath"
)

func jsSyntaxBootstrapProcess(directory string, names []string) bool {
	if len(names) == 0 || len(names) > markdownFileLimit {
		return false
	}
	root, err := os.OpenRoot(os.TempDir())
	if err != nil {
		return false
	}
	name := "logbrew-js-parser-" + rand.Text()
	if err := root.Mkdir(name, pythonBundleDirectoryMode); err != nil {
		if root.Close() != nil {
			return false
		}
		return false
	}
	parent := filepath.Join(root.Name(), name)
	identity, statError := root.Lstat(filepath.Base(parent))
	if statError != nil {
		if root.Close() != nil {
			return false
		}
		return false
	}
	destination := filepath.Join(parent, "native-parser")
	passed := false
	if runJSParserBootstrap([]string{destination}, io.Discard, io.Discard) == exitOK {
		passed = jsSyntaxProcessWithExecutable(directory, names, filepath.Join(destination, "oxlint"))
	}
	removed := removePythonStaging(root, filepath.Base(parent), identity)
	closeError := root.Close()
	return passed && removed && closeError == nil
}
