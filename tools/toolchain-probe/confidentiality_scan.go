package main

import (
	"cmp"
	"context"
	"os"
	"path"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	confidentialityCancelled        = "cancelled"
	confidentialityFindingsExceeded = "finding_limit"
	confidentialityMode             = "confidentiality-check"
	confidentialityPassed           = "passed"
	confidentialityFailed           = "failed"
	confidentialityUnavailable      = "unavailable"
	confidentialityContentRule      = "sensitive_text"
	confidentialityGuideRule        = "agent_home_path"
	confidentialityReadmeRule       = "readme_language"
	confidentialityPlanningRule     = "planning_path"
	confidentialityFindingLimit     = 256
	confidentialityByteLimit        = 256 << 20
	confidentialityLineLimit        = 1 << 20
	confidentialityLineCountLimit   = 500_000
)

type confidentialityFinding struct {
	Path string `json:"path"`
	Rule string `json:"rule"`
	Line int    `json:"line"`
}

type confidentialityReport struct {
	Status                string                   `json:"status"`
	FailureCode           string                   `json:"failure_code,omitempty"`
	FailurePath           string                   `json:"failure_path,omitempty"`
	Findings              []confidentialityFinding `json:"findings"`
	PolicySourcesExcluded []string                 `json:"policy_sources_excluded"`
	SchemaVersion         int                      `json:"schema_version"`
	FilesTotal            int                      `json:"files_total"`
	FilesScanned          int                      `json:"files_scanned"`
	BytesScanned          int64                    `json:"bytes_scanned"`
}

func scanConfidentiality(ctx context.Context, directory string) confidentialityReport {
	report := confidentialityReport{
		Status: confidentialityUnavailable, FailureCode: "", FailurePath: "",
		Findings: []confidentialityFinding{}, SchemaVersion: 1,
		PolicySourcesExcluded: []string{},
		FilesTotal:            0, FilesScanned: 0, BytesScanned: 0,
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		report.FailureCode = "root_unavailable"
		return report
	}
	report.FailureCode = scanConfidentialityRoot(ctx, directory, root, &report)
	if closeError := root.Close(); closeError != nil {
		report.FailureCode = "root_close_failed"
	}
	if ctx.Err() != nil {
		report.FailureCode = confidentialityCancelled
	}
	if report.FailureCode == "" {
		report.Status = confidentialityPassed
		if len(report.Findings) != 0 {
			report.Status = confidentialityFailed
		}
	}
	slices.SortFunc(report.Findings, func(first, second confidentialityFinding) int {
		return cmp.Or(cmp.Compare(first.Path, second.Path),
			cmp.Compare(first.Line, second.Line), cmp.Compare(first.Rule, second.Rule))
	})
	return report
}

func scanConfidentialityRoot(
	ctx context.Context, directory string, root *os.Root, report *confidentialityReport,
) string {
	files, err := confidentialityRootFiles(ctx, directory, root)
	if err != nil {
		return "inventory_unavailable"
	}
	report.FilesTotal = len(files)
	paths, err := confidentialityRootPlanning(ctx, directory, root)
	if err != nil {
		return "planning_unavailable"
	}
	for _, name := range paths {
		if !report.addFinding(name, 0, confidentialityPlanningRule) {
			return confidentialityFindingsExceeded
		}
	}
	policy := newConfidentialityPolicy()
	for _, name := range files {
		if confidentialityPolicySource(name) {
			report.PolicySourcesExcluded = append(report.PolicySourcesExcluded, name)
			continue
		}
		if code := report.scanFile(ctx, root, policy, name); code != "" {
			report.FailurePath = name
			return code
		}
	}
	return ""
}

// These six files replace the former self-exempt checker. Tests, command
// handling and neighboring implementation files remain subject to its policy.
func confidentialityPolicySource(name string) bool {
	switch name {
	case "tools/toolchain-probe/confidentiality_exact.go",
		"tools/toolchain-probe/confidentiality_fragments.go",
		"tools/toolchain-probe/confidentiality_policy.go",
		"tools/toolchain-probe/confidentiality_runtime.go",
		"tools/toolchain-probe/confidentiality_support.go",
		"tools/toolchain-probe/confidentiality_text.go":
		return true
	default:
		return false
	}
}

func (report *confidentialityReport) scanFile(
	ctx context.Context, root *os.Root, policy confidentialityPolicy, name string,
) string {
	if ctx.Err() != nil {
		return confidentialityCancelled
	}
	input, openError := openRootCheckInput(root, name)
	if openError != nil {
		return "file_unavailable"
	}
	data, valid := readCheckBytes(input, min(maximumOutputFile, confidentialityByteLimit-report.BytesScanned))
	if !valid {
		return "file_read_or_size_limit"
	}
	if path.Base(name) == policyRootGuide && !utf8.Valid(data) {
		return "readme_encoding_invalid"
	}
	if code := report.scanText(ctx, policy, name, strings.ToValidUTF8(string(data), "")); code != "" {
		return code
	}
	report.FilesScanned++
	report.BytesScanned += int64(len(data))
	return ""
}

func (report *confidentialityReport) addFinding(name string, line int, rule string) bool {
	if len(report.Findings) >= confidentialityFindingLimit {
		return false
	}
	report.Findings = append(report.Findings, confidentialityFinding{Path: name, Line: line, Rule: rule})
	return true
}

func (report *confidentialityReport) scanText(
	ctx context.Context, policy confidentialityPolicy, name, content string,
) string {
	if path.Dir(name) == "assets/brand" && path.Ext(name) == ".svg" {
		return ""
	}
	lineNumber := 0
	for line := range confidentialityLineSeq(content) {
		lineNumber++
		if ctx.Err() != nil {
			return confidentialityCancelled
		}
		if len(line) > confidentialityLineLimit || lineNumber > confidentialityLineCountLimit {
			return "line_limit"
		}
		rule := confidentialityLineRule(policy, name, line)
		if rule != "" && !report.addFinding(name, lineNumber, rule) {
			return confidentialityFindingsExceeded
		}
		if path.Base(name) == policyRootGuide && confidentialityREADMEForbidden(line) &&
			!report.addFinding(name, lineNumber, confidentialityReadmeRule) {
			return confidentialityFindingsExceeded
		}
	}
	return ""
}

func confidentialityLineRule(policy confidentialityPolicy, name, line string) string {
	if confidentialityHomePath(name, line) {
		return confidentialityGuideRule
	}
	if confidentialityTerms(line) != "" && !policy.allowed(name, line) {
		return confidentialityContentRule
	}
	return ""
}
