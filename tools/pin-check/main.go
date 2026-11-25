// Pin-check fails when a workflow, script, or Dockerfile in the repository
// installs a dependency that the OpenSSF Scorecard Pinned-Dependencies check
// reports as unpinned, unless quality/unpinned-installs.tsv lists that command
// with the reason it stays unpinned. It also fails when a listed command no
// longer exists, so the list cannot go stale. It skips files under a
// node_modules folder: those belong to installed packages, which the checks
// install before this one runs, and Scorecard never sees them in the
// repository.
//
// Usage: go -C tools/pin-check run . [REPOSITORY_ROOT]
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ossf/scorecard/v5/checker"
	"github.com/ossf/scorecard/v5/checks/raw"
	"github.com/ossf/scorecard/v5/clients"
	"github.com/ossf/scorecard/v5/clients/localdir"
	"github.com/ossf/scorecard/v5/log"
)

const allowlistPath = "quality/unpinned-installs.tsv"

// install is one dependency install, keyed the way the allowlist names it.
type install struct {
	path    string
	command string
}

func main() {
	root := "."
	if len(os.Args) > 1 {
		root = os.Args[1]
	}
	code, err := run(root, os.Stdout, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pin-check:", err)
		os.Exit(2)
	}
	os.Exit(code)
}

func run(root string, stdout, stderr io.Writer) (int, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return 0, err
	}
	allowed, err := readAllowlist(filepath.Join(root, allowlistPath))
	if err != nil {
		return 0, err
	}
	unpinned, total, err := scan(root)
	if err != nil {
		return 0, err
	}

	var problems []string
	seen := map[install]bool{}
	for _, dep := range unpinned {
		key := install{dep.Location.Path, normalize(dep.Location.Snippet)}
		seen[key] = true
		if _, ok := allowed[key]; ok {
			continue
		}
		problems = append(problems, fmt.Sprintf("%s:%d: %s is not pinned: %s",
			dep.Location.Path, dep.Location.Offset, dep.Type, key.command))
	}
	for key := range allowed {
		if !seen[key] {
			problems = append(problems, fmt.Sprintf(
				"%s: %s lists `%s`, but %s has no such unpinned install; remove the row",
				allowlistPath, key.path, key.command, key.path))
		}
	}
	sort.Strings(problems)
	for _, problem := range problems {
		fmt.Fprintln(stderr, "pin-check:", problem)
	}
	if len(problems) > 0 {
		fmt.Fprintf(stderr, "pin-check: pin each install by digest or lockfile, or list it in %s with a reason\n", allowlistPath)
		return 1, nil
	}
	fmt.Fprintf(stdout, "pin-check: %d installs pinned, %d listed in %s\n", total-len(unpinned), len(allowed), allowlistPath)
	return 0, nil
}

// scan runs the Scorecard Pinned-Dependencies collector on a local directory.
func scan(root string) ([]checker.Dependency, int, error) {
	ctx := context.Background()
	client := localdir.CreateLocalDirClient(ctx, log.NewLogger(log.ErrorLevel))
	repo, err := localdir.MakeLocalDirRepo(root)
	if err != nil {
		return nil, 0, err
	}
	if err := client.InitRepo(repo, clients.HeadSHA, 0); err != nil {
		return nil, 0, err
	}
	defer client.Close()
	data, err := raw.PinningDependencies(&checker.CheckRequest{
		Ctx:        ctx,
		RepoClient: client,
		Repo:       repo,
		Dlogger:    checker.NewLogger(),
	})
	if err != nil {
		return nil, 0, err
	}
	if len(data.ProcessingErrors) > 0 {
		var errs []error
		for _, e := range data.ProcessingErrors {
			if !installed(e.Location.Path) {
				errs = append(errs, fmt.Errorf("%s: %w", e.Location.Path, e.Err))
			}
		}
		if len(errs) > 0 {
			return nil, 0, errors.Join(errs...)
		}
	}
	var unpinned []checker.Dependency
	total := 0
	for _, dep := range data.Dependencies {
		if dep.Location != nil && installed(dep.Location.Path) {
			continue
		}
		total++
		if dep.Pinned != nil && !*dep.Pinned && dep.Location != nil {
			unpinned = append(unpinned, dep)
		}
	}
	return unpinned, total, nil
}

// installed reports whether path lies in a node_modules folder.
func installed(path string) bool {
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if part == "node_modules" {
			return true
		}
	}
	return false
}

// readAllowlist reads `path<TAB>command<TAB>reason` rows; # starts a comment.
// A missing file allows nothing, so every unpinned install fails.
func readAllowlist(path string) (map[install]string, error) {
	allowed := map[install]string{}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return allowed, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	lines := bufio.NewScanner(file)
	for n := 1; lines.Scan(); n++ {
		line := lines.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) != 3 || fields[0] == "" || fields[1] == "" || strings.TrimSpace(fields[2]) == "" {
			return nil, fmt.Errorf("%s:%d: want path, command, and reason separated by tabs", path, n)
		}
		key := install{fields[0], normalize(fields[1])}
		if _, dup := allowed[key]; dup {
			return nil, fmt.Errorf("%s:%d: duplicate row", path, n)
		}
		allowed[key] = fields[2]
	}
	return allowed, lines.Err()
}

// normalize joins continued lines and collapses runs of spaces.
func normalize(command string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(command, "\\\n", " ")), " ")
}
