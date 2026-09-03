//go:build !darwin && !linux

package main

import (
	"errors"
	"os/exec"
)

func configureProcess(_ *exec.Cmd) (func() error, error) {
	return nil, errors.New("process-group supervision is unavailable on this platform")
}

func processAlive(_ int) bool {
	return false
}

func executeLimited(_ []string) int {
	return exitFailure
}
