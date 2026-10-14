package main

import (
	"bytes"
	"context"
	"os/exec"
	"strconv"
	"time"
)

const brandRenderTimeout = 15 * time.Second

func brandRenderPNG(ctx context.Context, svg []byte, size uint32) ([]byte, bool) {
	if size == 0 || size > brandPixelDimensionLimit || len(svg) > brandSVGByteLimit {
		return nil, false
	}
	executable, err := exec.LookPath("rsvg-convert")
	if err != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, brandRenderTimeout)
	defer cancel()
	output := &boundedOutput{cancel: cancel, data: nil, limited: false, limit: brandSVGByteLimit}
	diagnostic := &boundedOutput{cancel: cancel, data: nil, limited: false, limit: outputLimit}
	dimension := strconv.FormatUint(uint64(size), 10)
	//nolint:gosec // G204: fixed native renderer and flags, bounded validated numeric dimensions; no shell.
	command := exec.CommandContext(ctx, executable, "--format=png", "--width", dimension, "--height", dimension)
	command.Stdin = bytes.NewReader(svg)
	command.Stdout, command.Stderr = output, diagnostic
	if runManagedProcess(command) != nil || ctx.Err() != nil || output.limited || diagnostic.limited {
		return nil, false
	}
	return output.data, true
}
