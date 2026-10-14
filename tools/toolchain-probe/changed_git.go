package main

import (
	"context"
	"encoding/hex"
	"io"
	"os"
	"os/exec"
	"strings"
)

const (
	gitDiffArguments = 12
	gitSHA1Bytes     = 20
	gitSHA256Bytes   = 32
	gitStatusFields  = 2
)

type gitSelection struct{ event, before, head, base string }

type gitSnapshot struct {
	paths             []string
	fullUnitDiscovery bool
}

func changedGitSnapshot(parent context.Context, repo string, selection gitSelection) (gitSnapshot, bool) {
	ctx, cancel := context.WithTimeout(parent, inventoryTimeout)
	defer cancel()
	if selection.head == "" {
		selection.head = "HEAD"
	}
	head, valid := resolveGitCommit(ctx, repo, selection.head)
	if !valid {
		return gitSnapshot{}, false
	}
	args := make([]string, 0, gitDiffArguments)
	args = append(args, "diff-tree", "--root", "-m", "--no-commit-id", "-r")
	comparison := head
	base, separator := selection.before, ".."
	if selection.event == "pull_request" && selection.base != "" {
		base, separator = "origin/"+selection.base, "..."
	}
	if strings.Trim(base, "0") != "" {
		base, valid = resolveGitCommit(ctx, repo, base)
		if !valid {
			return gitSnapshot{}, false
		}
		args, comparison = append(args[:0], "diff"), base+separator+head
	}
	args = append(args, "--name-status", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", comparison, "--")
	data, valid := readGit(ctx, repo, args)
	if !valid {
		return gitSnapshot{}, false
	}
	return parseGitSnapshot(data)
}

func parseGitSnapshot(data []byte) (gitSnapshot, bool) {
	fields := strings.Split(string(data), "\x00")
	if fields[len(fields)-1] != "" || len(fields)%gitStatusFields != 1 {
		return gitSnapshot{}, false
	}
	snapshot := gitSnapshot{paths: make([]string, 0, len(fields)/gitStatusFields), fullUnitDiscovery: false}
	for index := 0; index < len(fields)-1; index += gitStatusFields {
		status, path := fields[index], fields[index+1]
		if len(status) != 1 || !strings.ContainsRune("ADMT", rune(status[0])) || path == "" {
			return gitSnapshot{}, false
		}
		snapshot.paths = append(snapshot.paths, path)
		if status == "D" && strings.HasPrefix(path, "tests/") && strings.HasSuffix(path, pythonSuffix) {
			snapshot.fullUnitDiscovery = true
		}
	}
	return snapshot, true
}

func resolveGitCommit(ctx context.Context, repo, reference string) (string, bool) {
	data, ok := readGit(ctx, repo, []string{"rev-parse", "--verify", "--end-of-options", reference + "^{commit}"})
	if !ok {
		return "", false
	}
	commit := strings.TrimSpace(string(data))
	decoded, err := hex.DecodeString(commit)
	return commit, err == nil && (len(decoded) == gitSHA1Bytes || len(decoded) == gitSHA256Bytes)
}

func readGit(ctx context.Context, repo string, arguments []string) ([]byte, bool) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	output := boundedOutput{cancel: cancel, data: nil, limited: false, limit: maximumOutputFile}
	// Reviewed 2026-09-05: callers construct read-only Git commands. Revision
	// inputs pass through rev-parse --end-of-options and become exact object IDs.
	//nolint:gosec // G204: no shell, bounded output/deadline, reaped process group.
	command := exec.CommandContext(ctx, "git", arguments...)
	command.Dir, command.Stdout, command.Stderr = repo, &output, io.Discard
	command.Env = readOnlyGitEnvironment()
	if err := runManagedProcess(command); err != nil || ctx.Err() != nil || output.limited {
		return nil, false
	}
	return output.data, true
}

func readOnlyGitEnvironment() []string {
	// Routing and injected configuration must not replace the caller's checkout.
	environment := make([]string, 0)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GIT_") {
			environment = append(environment, entry)
		}
	}
	return append(environment, "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
}
