//go:build darwin || linux

package main

import (
	"errors"
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
