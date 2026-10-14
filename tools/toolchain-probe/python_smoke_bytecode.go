package main

import (
	"context"
	"os"
	"path/filepath"
)

func (wheel *pythonSmokeWheel) installedLayout(directory string) (pythonInstalledLayout, bool) {
	data, readable := readPythonSmokeSupplied(filepath.Join(directory, "wheels", wheel.filename))
	receipt, valid := inspectPythonArchive(data, pythonWheel, wheel.id, wheel.version)
	entries, parsed := readPythonArchive(data, pythonWheel)
	layout, supported := pythonInstallLayout(entries, wheel.id, wheel.version)
	return layout, readable && valid && parsed && supported && receipt.SHA256 == wheel.receipt.SHA256
}

func (run *pythonSmokeRun) prepareBytecode(ctx context.Context, site string) bool {
	directory := filepath.Join(run.directory, "bytecode-reference")
	if os.Mkdir(directory, pythonBundleDirectoryMode) != nil {
		return false
	}
	reference, err := os.OpenRoot(directory)
	if err != nil {
		return false
	}
	valid := run.compileBytecode(ctx, site, directory, reference)
	closeError := reference.Close()
	return valid && closeError == nil && ctx.Err() == nil
}

func (run *pythonSmokeRun) compileBytecode(ctx context.Context, site, directory string, reference *os.Root) bool {
	for _, wheel := range run.wheels {
		layout, valid := wheel.installedLayout(run.directory)
		if !valid || !layout.stagePythonModule(site, reference) {
			return false
		}
		run.layouts = append(run.layouts, layout)
	}
	// Stock Python compiles product modules without importing them or loading site
	// startup hooks. Go verifies both the compiler output and the installed tree.
	if !run.call(ctx, run.python, []string{
		"-I", "-B", "-S", "-m", "compileall", "-q", "-f", "-j", "1", "-o", "0",
		"--invalidation-mode", "timestamp", "-s", directory, "-p", site, directory,
	}).valid {
		return false
	}
	for _, layout := range run.layouts {
		if !layout.bindPythonBytecode(reference) {
			return false
		}
	}
	return true
}
