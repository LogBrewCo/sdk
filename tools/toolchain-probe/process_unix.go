//go:build darwin || linux

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
)

const (
	systemProcessPID                    = 1
	processExists        syscall.Signal = 0
	limitedArgumentCount                = 2
)

func openCheckInput(path string) (*os.File, error) {
	// Reviewed 2026-09-05: the local checker intentionally reads its input path.
	// Its descriptor must be regular, bounded, nonblocking, and never echoed.
	//nolint:gosec // G304: file-limit, FIFO, and non-reflection tests cover this boundary.
	input, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("open package input: %w", err)
	}
	return input, nil
}

func openRootCheckInput(root *os.Root, name string) (*os.File, error) {
	before, err := root.Lstat(name)
	if err != nil || !before.Mode().IsRegular() {
		return nil, errors.Join(os.ErrInvalid, err)
	}
	input, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open scoped package input: %w", err)
	}
	// Root resolves in-tree links itself. Check the directory entry as well as
	// the opened descriptor; O_NOFOLLOW alone does not enforce a regular leaf.
	after, pathError := root.Lstat(name)
	opened, statError := input.Stat()
	if pathError != nil || statError != nil || !after.Mode().IsRegular() ||
		!os.SameFile(before, opened) || !os.SameFile(opened, after) {
		return nil, errors.Join(os.ErrInvalid, pathError, statError, input.Close())
	}
	return input, nil
}

func configureProcess(command *exec.Cmd) (func() error, error) {
	command.SysProcAttr = new(syscall.SysProcAttr)
	command.SysProcAttr.Setpgid = true

	return sync.OnceValue(func() error {
		if command.Process == nil || command.Process.Pid <= systemProcessPID {
			return os.ErrProcessDone
		}

		err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}

		return os.NewSyscallError("kill", err)
	}), nil
}

func processAlive(pid int) bool {
	err := syscall.Kill(pid, processExists)

	return err == nil || errors.Is(err, syscall.EPERM)
}

func executeLimited(arguments []string) int {
	if len(arguments) < limitedArgumentCount {
		return exitUsage
	}
	fileLimit, err := strconv.ParseUint(arguments[0], 10, 64)
	if err != nil || fileLimit == 0 || fileLimit > maximumOutputFile ||
		syscall.Setrlimit(syscall.RLIMIT_CORE,
			&syscall.Rlimit{Cur: 0, Max: 0}) != nil || syscall.Setrlimit(syscall.RLIMIT_FSIZE,
		&syscall.Rlimit{Cur: fileLimit, Max: fileLimit}) != nil {
		return exitFailure
	}
	// Reviewed 2026-09-03: runDeadline validates and bounds this exact command.
	//nolint:gosec // G204: execution is inside the owned limited process group.
	if err = syscall.Exec(arguments[1], arguments[1:], os.Environ()); err != nil {
		return exitFailure
	}
	return exitOK
}
