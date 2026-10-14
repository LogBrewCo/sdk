//go:build !darwin && !linux

package main

import (
	"errors"
	"os"
	"os/exec"
)

func openCheckInput(_ string) (*os.File, error) {
	return nil, errors.New("nonblocking package input is unavailable on this platform")
}

func configureProcess(_ *exec.Cmd) (func() error, error) {
	return nil, errors.New("process-group supervision is unavailable on this platform")
}

func processAlive(_ int) bool {
	return false
}

func executeLimited(_ []string) int {
	return exitFailure
}
