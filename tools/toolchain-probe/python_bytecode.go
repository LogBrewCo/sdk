package main

import (
	"os"
	"path"
	"strings"
)

const pythonCacheDirectory = "__pycache__"

// The compiler reference contains wheel bytes, never installed bytecode. Source
// timestamps and compileall's installed-path prefix reproduce pip's output.
func (layout pythonInstalledLayout) stagePythonModule(site string, reference *os.Root) bool {
	installed, err := os.OpenRoot(site)
	if err != nil {
		return false
	}
	valid := true
	for name := range layout.files {
		if strings.HasPrefix(name, layout.module+"/") && !layout.stagePythonFile(installed, reference, name) {
			valid = false
			break
		}
	}
	closeError := installed.Close()
	return valid && closeError == nil
}

func (layout pythonInstalledLayout) stagePythonFile(installed, reference *os.Root, name string) bool {
	info, err := installed.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || !layout.verifyFile(installed, name, name) ||
		reference.MkdirAll(path.Dir(name), pythonBundleDirectoryMode) != nil {
		return false
	}
	file, err := reference.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, pythonTemporaryFileMode)
	if err != nil {
		return false
	}
	return writePythonOutputFile(file, layout.files[name], pythonTemporaryFileMode) &&
		reference.Chtimes(name, info.ModTime(), info.ModTime()) == nil
}

func (layout pythonInstalledLayout) bindPythonBytecode(reference *os.Root) bool {
	pending, directories := make(map[string]bool), make(map[string]bool)
	budget := pythonArchiveBudget{members: 0, size: 0}
	for name, data := range layout.files {
		if !budget.accept(uint64(len(data))) {
			return false
		}
		if strings.HasPrefix(name, layout.module+"/") && strings.HasSuffix(name, ".py") {
			directory := path.Join(path.Dir(name), pythonCacheDirectory)
			pending[path.Join(directory, strings.TrimSuffix(path.Base(name), ".py"))] = true
			directories[directory] = true
		}
	}
	for range layout.directories {
		if !budget.accept(0) {
			return false
		}
	}
	for directory := range directories {
		if layout.directories[directory] || !budget.accept(0) ||
			!layout.bindPythonCacheDirectory(reference, directory, pending, &budget) {
			return false
		}
		layout.directories[directory] = true
	}
	remaining := pythonArchiveMemberLimit
	return len(pending) == 0 && layout.verifyDirectory(reference, layout.module, layout.module, &remaining)
}

func (layout pythonInstalledLayout) bindPythonCacheDirectory(
	reference *os.Root, directory string, pending map[string]bool, budget *pythonArchiveBudget,
) bool {
	info, err := reference.Lstat(directory)
	if err != nil || !info.IsDir() {
		return false
	}
	root, err := reference.OpenRoot(directory)
	if err != nil {
		return false
	}
	current, statError := root.Stat(".")
	entries, valid := readPythonDirectory(root, pythonArchiveMemberLimit-budget.members)
	valid = valid && statError == nil && os.SameFile(info, current)
	for _, entry := range entries {
		if !valid || !entry.Type().IsRegular() ||
			!layout.bindPythonCacheFile(root, directory, entry.Name(), pending, budget) {
			valid = false
			break
		}
	}
	closeError := root.Close()
	return valid && closeError == nil
}

func (layout pythonInstalledLayout) bindPythonCacheFile(
	root *os.Root, directory, name string, pending map[string]bool, budget *pythonArchiveBudget,
) bool {
	base := strings.TrimSuffix(name, ".pyc")
	dot := strings.LastIndexByte(base, '.')
	if base == name || dot <= 0 || dot == len(base)-1 {
		return false
	}
	source := path.Join(directory, base[:dot])
	if !pending[source] {
		return false
	}
	file, err := openRootCheckInput(root, name)
	if err != nil {
		return false
	}
	data, readable := readCheckInputLimit(file, pythonArchiveMemberBytes)
	if !readable || !budget.accept(uint64(len(data))) {
		return false
	}
	layout.files[path.Join(directory, name)] = data
	delete(pending, source)
	return true
}
