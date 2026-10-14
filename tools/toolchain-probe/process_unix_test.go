//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestPackageJSONRejectsFIFO(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "input.fifo")
	if err := syscall.Mkfifo(path, fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	var diagnostic bytes.Buffer
	if checkPackageJSON([]string{jsonFields, wantOK, path}, &diagnostic) != exitFailure {
		t.Fatal("non-regular input accepted")
	}
}

func TestPythonInstalledWheelRejectsFIFO(t *testing.T) {
	t.Parallel()
	for _, relative := range []string{
		pythonInstalledFixtureModule + "/__init__.py", pythonFixtureRoot + ".dist-info/INSTALLER",
	} {
		fixture := pythonInstallFixture(t)
		file := filepath.Join(fixture.site, relative)
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Mkfifo(file, fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
		fixture.run(t, exitFailure)
	}
}

const (
	repeatStops         = 3
	unstartedProcessPID = 0
)

func TestPythonMetadataRejectsSpecialFiles(t *testing.T) {
	t.Parallel()
	for _, name := range []string{pythonMetadataManifest, policyRootGuide} {
		for _, kind := range []os.FileMode{os.ModeDir, os.ModeSymlink, os.ModeNamedPipe} {
			root := pythonMetadataFixture(t)
			path := filepath.Join(root, pythonMetadataDirectory, "logbrew_flask", name)
			target := filepath.Join(t.TempDir(), name)
			if err := os.Rename(path, target); err != nil {
				t.Fatal(err)
			}
			var err error
			switch kind {
			case os.ModeDir:
				err = os.Mkdir(path, gitFixtureDirectoryMode)
			case os.ModeSymlink:
				err = os.Symlink(target, path)
			case os.ModeNamedPipe:
				err = syscall.Mkfifo(path, fixtureReceiptMode)
			default:
				t.Fatal("unsupported fixture mode")
			}
			if err != nil {
				t.Fatal(err)
			}
			assertPythonMetadataFailure(t, root)
		}
	}
}

func TestPythonMetadataRejectsEscapedDirectory(t *testing.T) {
	t.Parallel()
	root := pythonMetadataFixture(t)
	path := filepath.Join(root, pythonMetadataDirectory)
	target := filepath.Join(t.TempDir(), pythonMetadataDirectory)
	if err := os.Rename(path, target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	assertPythonMetadataFailure(t, root)
}

func TestProcessStopIsIdempotent(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(t.Context(), testProbeTimeout)
	defer cancel()

	// Reviewed 2026-09-03: this test invokes its own compiled sleep fixture.
	//nolint:gosec // G204: no caller-selected executable or arguments.
	command := exec.CommandContext(ctx, os.Args[0], "fixture:sleep")

	stop, err := configureProcess(command)
	if err != nil {
		t.Fatal(err)
	}

	command.Cancel, command.WaitDelay = stop, pipeWait

	err = command.Start()
	if err != nil {
		t.Fatal(err)
	}

	first := stop()

	time.Sleep(processExitPoll)

	for range repeatStops {
		err = stop()
		if !errors.Is(err, first) {
			t.Errorf("stop changed result for owned process %d: %v, want %v",
				command.Process.Pid, err, first)
		}
	}

	err = command.Wait()
	if first != nil || err == nil {
		t.Fatalf("expected successful stop and failed process: stop=%v wait=%v",
			first, err)
	}
}

func TestProcessStopRejectsNonChildIDs(t *testing.T) {
	t.Parallel()

	for _, pid := range []int{
		-systemProcessPID, unstartedProcessPID, systemProcessPID,
	} {
		command := &exec.Cmd{Process: &os.Process{Pid: pid}}

		stop, err := configureProcess(command)
		if err != nil {
			t.Fatal(err)
		}

		err = stop()
		if !errors.Is(err, os.ErrProcessDone) {
			t.Errorf("invalid process %d: %v", pid, err)
		}
	}
}
