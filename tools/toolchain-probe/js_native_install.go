package main

import (
	"context"
	"os"
	"path/filepath"
)

const jsNativeExecutableMode = 0o755

func jsNativeInstall(destination string, archive []byte, specification jsNativeArchive) bool {
	content, valid := jsNativeArchiveContent(archive, specification)
	if !valid {
		return false
	}
	return writeReleaseBundle(destination, func(root *os.Root) bool {
		return createVerifiedReleaseOutput(root, "oxlint", content, jsNativeExecutableMode) &&
			jsNativeVersion(context.Background(), filepath.Join(root.Name(), "oxlint")) &&
			syncPythonDirectory(root, ".")
	})
}
