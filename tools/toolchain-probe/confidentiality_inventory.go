package main

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

const confidentialityFileLimit = 100_000

var errConfidentialityInventory = errors.New("confidentiality inventory unavailable or unsafe")

func confidentialityPlanningPaths() []string {
	return []string{
		".agents", "CLAUDE.md", confidentialityResearchDir, "docs/private-plans",
		policyMemoryPath, "plans", "skills-lock.json",
	}
}

func confidentialityFiles(ctx context.Context, directory string) ([]string, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, errConfidentialityInventory
	}
	files, scanError := confidentialityRootFiles(ctx, directory, root)
	closeError := root.Close()
	if scanError != nil || closeError != nil {
		return nil, errConfidentialityInventory
	}
	return files, nil
}

func confidentialityRootFiles(ctx context.Context, directory string, root *os.Root) ([]string, error) {
	state, repository := readGit(ctx, directory, []string{"rev-parse", "--is-inside-work-tree"})
	if ctx.Err() != nil || !repository && !confidentialityStandalone(ctx, directory) {
		return nil, errConfidentialityInventory
	}
	if !repository {
		return walkConfidentialityFiles(ctx, root)
	}
	if string(state) != "true\n" {
		return nil, errConfidentialityInventory
	}
	data, valid := readGit(ctx, directory, []string{"ls-files", "--cached", "--others", "--exclude-standard", "-z"})
	if !valid || ctx.Err() != nil {
		return nil, errConfidentialityInventory
	}
	candidates, err := confidentialityGitPaths(data)
	if err != nil {
		return nil, err
	}
	return confidentialityExistingFiles(ctx, root, candidates)
}

func confidentialityExistingFiles(ctx context.Context, root *os.Root, candidates []string) ([]string, error) {
	files := make([]string, 0, len(candidates))
	for _, name := range candidates {
		if !confidentialityScannedPath(name) {
			continue
		}
		info, statError := root.Lstat(name)
		if errors.Is(statError, os.ErrNotExist) {
			continue
		}
		if statError != nil || !info.Mode().IsRegular() || ctx.Err() != nil {
			return nil, errConfidentialityInventory
		}
		files = append(files, name)
	}
	return files, nil
}

func confidentialityStandalone(ctx context.Context, directory string) bool {
	if _, err := exec.LookPath("git"); err != nil {
		return false
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return false
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return false
	}
	for {
		_, statError := os.Lstat(filepath.Join(resolved, ".git"))
		if !errors.Is(statError, os.ErrNotExist) || ctx.Err() != nil {
			return false
		}
		parent := filepath.Dir(resolved)
		if parent == resolved {
			return true
		}
		resolved = parent
	}
}

func confidentialityGitPaths(data []byte) ([]string, error) {
	if len(data) == 0 {
		return []string{}, nil
	}
	fields := strings.Split(string(data), "\x00")
	if fields[len(fields)-1] != "" || len(fields) > confidentialityFileLimit+1 {
		return nil, errConfidentialityInventory
	}
	fields = fields[:len(fields)-1]
	for _, name := range fields {
		if !confidentialitySafePath(name) {
			return nil, errConfidentialityInventory
		}
	}
	slices.Sort(fields)
	return slices.Compact(fields), nil
}

func confidentialitySafePath(name string) bool {
	return name != "." && fs.ValidPath(name) && utf8.ValidString(name) &&
		!strings.ContainsFunc(name, unicode.IsControl) && !strings.Contains(name, "\\")
}

func confidentialitySkippedDirectory(name string) bool {
	return strings.HasSuffix(name, ".egg-info") || slices.Contains([]string{
		".agents", ".git", ".mypy_cache", ".pytest_cache", ".venv", "__pycache__",
		"build", "dist", "node_modules", "target", "vendor",
	}, name)
}

func confidentialityScannedPath(name string) bool {
	if path.Base(name) == "LICENSE" ||
		slices.Contains([]string{".gif", ".ico", ".jpg", ".jpeg", ".png", ".webp"}, strings.ToLower(path.Ext(name))) {
		return false
	}
	for part := range strings.SplitSeq(name, "/") {
		if confidentialitySkippedDirectory(part) {
			return false
		}
	}
	return true
}

func walkConfidentialityFiles(ctx context.Context, root *os.Root) ([]string, error) {
	files := make([]string, 0)
	visited := 0
	err := fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, walkError error) error {
		visited++
		if walkError != nil || ctx.Err() != nil || visited > confidentialityFileLimit {
			return errConfidentialityInventory
		}
		if entry.IsDir() {
			if confidentialitySkippedDirectory(entry.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if confidentialityScannedPath(name) {
			if !entry.Type().IsRegular() || !confidentialitySafePath(name) {
				return errConfidentialityInventory
			}
			files = append(files, name)
		}
		return nil
	})
	if err != nil {
		return nil, errConfidentialityInventory
	}
	slices.Sort(files)
	return files, nil
}

func confidentialityPlanning(ctx context.Context, directory string) ([]string, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, errConfidentialityInventory
	}
	findings, scanError := confidentialityRootPlanning(ctx, directory, root)
	if closeError := root.Close(); scanError != nil || closeError != nil {
		return nil, errConfidentialityInventory
	}
	return findings, nil
}

func confidentialityRootPlanning(ctx context.Context, directory string, root *os.Root) ([]string, error) {
	findings := make([]string, 0)
	for _, name := range confidentialityPlanningPaths() {
		if ctx.Err() != nil {
			return nil, errConfidentialityInventory
		}
		_, err := root.Lstat(name)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, errConfidentialityInventory
		}
		if _, ignored := readGit(ctx, directory, []string{"check-ignore", "--", name}); ignored {
			continue
		}
		if ctx.Err() != nil {
			return nil, errConfidentialityInventory
		}
		findings = append(findings, name)
	}
	return findings, nil
}
