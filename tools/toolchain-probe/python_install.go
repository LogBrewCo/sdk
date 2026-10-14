package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const pythonInstalledMode = "verify-installed"

type pythonInstalledLayout struct {
	files       map[string][]byte
	directories map[string]bool
	module      string
	metadata    string
}

func runPythonInstalled(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 5 || !filepath.IsAbs(arguments[4]) ||
		!validPythonArchiveSelection([]string{pythonWheel, arguments[1], arguments[2], arguments[3]}) {
		return writeText(diagnostic,
			"verify-installed requires absolute wheel and site paths, package ID, and version\n", exitUsage)
	}
	data, readable := readCheckFile(arguments[1])
	receipt, valid := inspectPythonArchive(data, pythonWheel, arguments[2], arguments[3])
	entries, parsed := readPythonArchive(data, pythonWheel)
	layout, supported := pythonInstallLayout(entries, arguments[2], arguments[3])
	if !readable || !valid || !parsed || !supported || !layout.verify(arguments[4]) {
		return writeText(diagnostic, "Installed Python package does not match the verified wheel\n", exitFailure)
	}
	receipt.Scope, receipt.Files = "python_installed_wheel_identity", len(layout.files)-1
	if err := json.NewEncoder(output).Encode(receipt); err != nil {
		return exitFailure
	}
	return exitOK
}

// This proof supports the pure-Python package layout used by LogBrew, not
// arbitrary wheel relocation, scripts, or editable installs.
func pythonInstallLayout(entries []pythonArchiveEntry, packageID, version string) (pythonInstalledLayout, bool) {
	layout := pythonInstalledLayout{
		files: make(map[string][]byte), directories: make(map[string]bool),
		module:   strings.ReplaceAll(packageID, "-", "_"),
		metadata: pythonArtifactRoot(packageID, version) + ".dist-info",
	}
	for _, entry := range entries {
		name := strings.TrimSuffix(entry.name, "/")
		if name != layout.module && name != layout.metadata &&
			!strings.HasPrefix(name, layout.module+"/") && !strings.HasPrefix(name, layout.metadata+"/") {
			return layout, false
		}
		if entry.directory {
			layout.directories[name] = true
		} else {
			layout.files[name] = entry.data
		}
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			layout.directories[parent] = true
			if len(layout.files)+len(layout.directories) > pythonArchiveMemberLimit {
				return layout, false
			}
		}
	}
	for _, required := range []string{
		layout.module + "/__init__.py", layout.metadata + "/METADATA",
		layout.metadata + "/WHEEL", layout.metadata + "/RECORD",
	} {
		if _, exists := layout.files[required]; !exists {
			return layout, false
		}
	}
	return layout, len(layout.files)+len(layout.directories) <= pythonArchiveMemberLimit
}

func (layout pythonInstalledLayout) verify(directory string) bool {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return false
	}
	remaining := pythonArchiveMemberLimit
	valid := layout.verifyDirectory(root, layout.module, layout.module, &remaining) &&
		layout.verifyDirectory(root, layout.metadata, layout.metadata, &remaining)
	closeError := root.Close()
	return valid && closeError == nil
}

func (layout pythonInstalledLayout) verifyDirectory(parent *os.Root, name, prefix string, remaining *int) bool {
	info, err := parent.Lstat(name)
	if err != nil || !info.IsDir() {
		return false
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return false
	}
	current, statError := root.Stat(".")
	valid := statError == nil && os.SameFile(info, current) && layout.verifyEntries(root, prefix, remaining)
	closeError := root.Close()
	return valid && closeError == nil
}

func (layout pythonInstalledLayout) verifyEntries(root *os.Root, prefix string, remaining *int) bool {
	entries, valid := readPythonDirectory(root, *remaining)
	if !valid {
		return false
	}
	*remaining -= len(entries)
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		name := prefix + "/" + entry.Name()
		seen[name] = true
		if entry.IsDir() {
			if !layout.directories[name] || !layout.verifyDirectory(root, entry.Name(), name, remaining) {
				return false
			}
			continue
		}
		if !entry.Type().IsRegular() || !layout.verifyFile(root, entry.Name(), name) {
			return false
		}
	}
	return layout.hasExpectedEntries(prefix, seen)
}

func (layout pythonInstalledLayout) hasExpectedEntries(prefix string, seen map[string]bool) bool {
	for name := range layout.files {
		if path.Dir(name) == prefix && !seen[name] {
			return false
		}
	}
	for name := range layout.directories {
		if path.Dir(name) == prefix && !seen[name] {
			return false
		}
	}
	return true
}

func (layout pythonInstalledLayout) verifyFile(root *os.Root, name, relative string) bool {
	expected, exists := layout.files[relative]
	mutable := relative == layout.metadata+"/RECORD" || !exists && layout.installerMetadata(relative)
	if !exists && !mutable {
		return false
	}
	file, err := openRootCheckInput(root, name)
	if err != nil {
		return false
	}
	info, statError := file.Stat()
	valid := statError == nil && info.Mode().IsRegular() && info.Size() <= pythonArchiveMemberBytes
	if valid && !mutable {
		actual, readError := io.ReadAll(io.LimitReader(file, int64(len(expected))+1))
		valid = readError == nil && bytes.Equal(actual, expected)
	}
	closeError := file.Close()
	return valid && closeError == nil
}

func (layout pythonInstalledLayout) installerMetadata(relative string) bool {
	if path.Dir(relative) != layout.metadata {
		return false
	}
	switch path.Base(relative) {
	case "INSTALLER", "REQUESTED", "direct_url.json", "uv_cache.json":
		return true
	default:
		return false
	}
}

func readPythonDirectory(root *os.Root, limit int) ([]os.DirEntry, bool) {
	directory, err := root.Open(".")
	if err != nil {
		return nil, false
	}
	entries, readError := directory.ReadDir(limit + 1)
	closeError := directory.Close()
	return entries, (readError == nil || errors.Is(readError, io.EOF)) && closeError == nil && len(entries) <= limit
}
