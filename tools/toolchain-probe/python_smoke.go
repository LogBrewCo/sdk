package main

import (
	"context"
	"encoding/json"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type pythonSmokeRun struct {
	checker                    *checkedSchema
	wheels                     []pythonSmokeWheel
	layouts                    []pythonInstalledLayout
	commandElapsed             []int64
	directory, uv, pip, python string
	options                    pythonSmokeOptions
	installer                  pythonConsumerOutput
	last                       pythonConsumerOutput
	bindingElapsed             time.Duration
	runtimeElapsed             time.Duration
}

func runPythonSmoke(arguments []string, output, diagnostic io.Writer) int {
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), pythonConsumerTimeout)
	defer cancel()
	options, valid := parsePythonSmokeOptions(arguments, os.Getenv)
	if !valid {
		return writeText(diagnostic, "Invalid public Python package selection\n", exitUsage)
	}
	repository, pathError := os.Getwd()
	schema, readable := readCheckFile(filepath.Join(repository, "spec", "event-batch.schema.json"))
	checker, schemaError := compileCheckSchema(schema)
	if pathError != nil || !readable || schemaError != nil {
		return writeText(diagnostic, "Public Python consumer requires the SDK repository schema\n", exitFailure)
	}
	directory, err := os.MkdirTemp("", "logbrew-python-public-")
	if err != nil {
		return writeText(diagnostic, "Public Python consumer temporary directory unavailable\n", exitFailure)
	}
	run := pythonSmokeRun{
		options: options, directory: directory, uv: "", pip: "", python: "", wheels: nil, checker: checker,
		last:           pythonConsumerOutput{stdout: nil, stderr: nil, valid: false},
		installer:      pythonConsumerOutput{stdout: nil, stderr: nil, valid: false},
		commandElapsed: nil, layouts: nil, bindingElapsed: 0, runtimeElapsed: 0,
	}
	failure := run.execute(ctx)
	if err = os.RemoveAll(directory); err != nil {
		failure = "temporary directory cleanup"
	}
	if failure == "" && ctx.Err() != nil {
		failure = "execution deadline"
	}
	if !run.writeDiagnostics(failure, time.Since(started), ctx.Err() != nil) {
		return writeText(diagnostic, "Public Python consumer diagnostic write failed\n", exitFailure)
	}
	if failure != "" {
		return writeText(diagnostic, "Public Python consumer failed: "+failure+"\n", exitFailure)
	}
	return run.writeReceipt(output)
}

func (run *pythonSmokeRun) execute(ctx context.Context) string {
	if !run.resolveTools() {
		return "pinned installer or Python unavailable"
	}
	if !run.verifyInstallerVersions(ctx) {
		return "pinned installer version mismatch"
	}
	client := newPythonRegistryClient()
	if client == nil {
		return "registry client unavailable"
	}
	defer client.CloseIdleConnections()
	bindingStarted := time.Now()
	wheels, bound := bindPythonSmokeWheels(ctx, run.options,
		filepath.Join(run.directory, "wheels"), client, os.Getenv)
	run.bindingElapsed = time.Since(bindingStarted)
	if !bound {
		return "artifact binding"
	}
	run.wheels = wheels
	venv := filepath.Join(run.directory, "venv")
	if !run.call(ctx, run.uv, []string{
		"venv", pythonTargetFlag, run.python, "--no-project", "--no-python-downloads", "--no-config",
		"--no-cache", venv,
	}).valid {
		return "isolated environment creation"
	}
	run.python = filepath.Join(venv, "bin", "python")
	if failure := run.install(ctx); failure != "" {
		return failure
	}
	site, found := pythonSmokeSite(venv)
	if !found || !run.prepareBytecode(ctx, site) {
		return "bytecode reference preparation"
	}
	if !run.verifyInstalled(ctx, site) {
		return "installed bytes before runtime"
	}
	started := time.Now()
	run.last = checkPythonPublicRuntime(ctx, run.python, run.directory, run.options.versions, run.checker)
	run.runtimeElapsed = time.Since(started)
	if !run.last.valid {
		return "installed runtime evidence"
	}
	for _, arguments := range [][]string{
		{"show", pythonCoreID, pythonFastAPIID, pythonFlaskID, pythonDjangoID},
		{"list", "--format=json"},
		{"freeze"},
	} {
		if !run.callPip(ctx, arguments).valid {
			return "installed dependency inventory"
		}
	}
	if !run.verifyInstalled(ctx, site) {
		return "installed bytes after runtime"
	}
	return ""
}

func (run *pythonSmokeRun) resolveTools() bool {
	uv := os.Getenv("LOGBREW_UV_BIN")
	if uv == "" {
		uv = "uv"
	}
	resolved, err := exec.LookPath(uv)
	if err != nil && os.Getenv("LOGBREW_UV_BIN") == "" {
		home, homeError := os.UserHomeDir()
		if homeError != nil {
			return false
		}
		fallback := filepath.Join(home, ".local", "share", "logbrew-tools", "uv", pythonSmokeUVVersion, "bin", "uv")
		resolved, err = exec.LookPath(fallback)
	}
	python := os.Getenv("LOGBREW_PYTHON_BIN")
	if python == "" {
		python = "python3"
	}
	interpreter, pythonError := exec.LookPath(python)
	pip := os.Getenv("LOGBREW_PIP_BIN")
	if pip == "" {
		pip = pythonPipCommand
	}
	controller, pipError := exec.LookPath(pip)
	if err != nil || pythonError != nil || pipError != nil {
		return false
	}
	run.uv, run.python, run.pip = resolved, interpreter, controller
	return true
}

func (run *pythonSmokeRun) verifyInstallerVersions(ctx context.Context) bool {
	version := run.call(ctx, run.uv, []string{versionFlag})
	if !version.valid || !strings.HasPrefix(string(version.stdout), "uv "+pythonSmokeUVVersion+" ") {
		return false
	}
	version = run.call(ctx, run.pip, []string{pythonIsolatedFlag, versionFlag})
	return version.valid && strings.HasPrefix(string(version.stdout), "pip "+pythonSmokePipVersion+" from ")
}

func (run *pythonSmokeRun) callPip(ctx context.Context, arguments []string) pythonConsumerOutput {
	return run.call(ctx, run.pip, append([]string{pythonIsolatedFlag, pythonTargetFlag, run.python}, arguments...))
}

func (run *pythonSmokeRun) call(ctx context.Context, program string, arguments []string) pythonConsumerOutput {
	started := time.Now()
	run.last = runPythonConsumerEnvironment(ctx, program, run.directory, arguments, []string{
		"UV_CONCURRENT_DOWNLOADS=8", "UV_HTTP_TIMEOUT=5", "UV_HTTP_RETRIES=0", "UV_NO_PROGRESS=1",
		"PIP_CONFIG_FILE=" + os.DevNull, "PIP_DISABLE_PIP_VERSION_CHECK=1",
		"PYTHONNOUSERSITE=1", "PYTHONSAFEPATH=1", "PYTHONDONTWRITEBYTECODE=1",
	})
	run.commandElapsed = append(run.commandElapsed, time.Since(started).Milliseconds())
	return run.last
}

func (run *pythonSmokeRun) writeDiagnostics(failure string, elapsed time.Duration, expired bool) bool {
	filename := os.Getenv("LOGBREW_PYTHON_DIAGNOSTICS")
	if filename == "" {
		return true
	}
	document := run.last.diagnostic()
	maps.Copy(document, map[string]any{
		"scope": "python_consumer_execution", "stage": failure, "untrusted_output": true,
		"installer": run.installer.diagnostic(), "deadline_exceeded": expired, "elapsed_ms": elapsed.Milliseconds(),
		"command_elapsed_ms": run.commandElapsed, "runtime_elapsed_ms": run.runtimeElapsed.Milliseconds(),
		"binding_elapsed_ms": run.bindingElapsed.Milliseconds(),
	})
	data, err := json.Marshal(document)
	return err == nil && writePythonManifestFile(filename, data)
}

func (output pythonConsumerOutput) diagnostic() map[string]any {
	const limit = 64 << 10
	return map[string]any{
		"stdout":    string(output.stdout[:min(len(output.stdout), limit)]),
		"stderr":    string(output.stderr[:min(len(output.stderr), limit)]),
		"truncated": len(output.stdout) > limit || len(output.stderr) > limit,
	}
}

func (run *pythonSmokeRun) install(ctx context.Context) string {
	requirements := make([]string, 0, len(run.wheels))
	ids := make([]string, 0, len(run.wheels))
	for _, wheel := range run.wheels {
		requirements = append(requirements, filepath.Join(run.directory, "wheels", wheel.filename)+
			pythonSmokeExtras(wheel.id, wheel.version))
		ids = append(ids, wheel.id)
	}
	arguments := append([]string{
		pythonPipCommand, "install", pythonTargetFlag, run.python, "--strict", "--no-cache", "--no-config",
		"--no-python-downloads",
		"--only-binary", ":all:", "--default-index", "https://pypi.org/simple",
	}, requirements...)
	run.installer = run.call(ctx, run.uv, arguments)
	if !run.installer.valid {
		return "public dependency installation"
	}
	if !run.callPip(ctx, append([]string{"uninstall", "-y"}, ids...)).valid {
		return "pip replay removal"
	}
	arguments = append([]string{
		"install", "--disable-pip-version-check", "--no-cache-dir", "--no-index",
		"--timeout", "5", "--retries", "0", "--only-binary=:all:",
	}, requirements...)
	if !run.callPip(ctx, arguments).valid {
		return "offline pip replay"
	}
	if !run.callPip(ctx, []string{"check"}).valid {
		return "installed dependency compatibility"
	}
	return ""
}

func (run *pythonSmokeRun) verifyInstalled(ctx context.Context, site string) bool {
	if len(run.wheels) == 0 || len(run.layouts) != len(run.wheels) {
		return false
	}
	for index, wheel := range run.wheels {
		_, valid := wheel.installedLayout(run.directory)
		if !valid || !run.layouts[index].verify(site) {
			return false
		}
	}
	return ctx.Err() == nil
}

func pythonSmokeSite(venv string) (string, bool) {
	root, err := os.OpenRoot(filepath.Join(venv, "lib"))
	if err != nil {
		return "", false
	}
	entries, valid := readPythonDirectory(root, pythonArchiveMemberLimit)
	closeError := root.Close()
	selected := ""
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "python3.") && entry.IsDir() {
			if selected != "" {
				return "", false
			}
			selected = filepath.Join(venv, "lib", entry.Name(), "site-packages")
		}
	}
	canonical, resolveError := filepath.EvalSymlinks(selected)
	return canonical, valid && closeError == nil && selected != "" && resolveError == nil
}

func (run *pythonSmokeRun) writeReceipt(output io.Writer) int {
	artifacts := make([]map[string]string, 0, len(run.wheels))
	for _, wheel := range run.wheels {
		artifacts = append(artifacts,
			map[string]string{"id": "pypi:" + wheel.id, "digest": "sha256:" + wheel.receipt.SHA256})
	}
	document := map[string]any{"schema_version": 1, "status": "passed", "artifacts": artifacts}
	if !run.options.receipt {
		document["scope"], document["runtime_runs"] = "installed_python_public_consumer", 2
	}
	if err := json.NewEncoder(output).Encode(document); err != nil {
		return exitFailure
	}
	return exitOK
}
