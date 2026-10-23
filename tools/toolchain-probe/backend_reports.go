package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const (
	backendReportsMode = "backend-reports"
	backendReportDir   = "docs/backend-contracts"
)

var (
	reportHeading      = regexp.MustCompile(`(?m)^(#{1,6})\s+(.+?)\s*$`)
	reportPriority     = regexp.MustCompile(`\bP[0-3]\b`)
	reportStatus       = regexp.MustCompile(`(?i)\b(backend contract status|SDK-facing contract|public API contract)\b`)
	reportVerification = regexp.MustCompile(`(?i)\b(tests?|verifiers?|proof|smoke)\b`)
	reportSections     = []string{
		"Status", "Priority", "User Impact", "Expected Backend Capability", "SDK Gap Observed", "Verification Needed",
	}
	reportCapabilityMarkers = []string{"Suggested APIs", "Suggested API", "event", "fields", "Runtime telemetry"}
)

// checkBackendReports fails when a backend contract report lacks a required
// section or the status, priority, capability, or verification it must state.
func checkBackendReports(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 {
		return writeText(diagnostic, "usage: backend-reports <repository-root>\n", exitUsage)
	}
	failures := backendReportFailures(arguments[0])
	if len(failures) > 0 {
		return writeText(diagnostic, strings.Join(failures, "\n")+"\n", exitFailure)
	}
	return writeText(output, "backend contract reports ok\n", exitOK)
}

func backendReportFailures(root string) []string {
	if _, err := os.Stat(filepath.Join(root, backendReportDir)); err != nil {
		return []string{"missing backend contract report directory: " + backendReportDir}
	}
	reports, _ := filepath.Glob(filepath.Join(root, backendReportDir, "*.md"))
	if len(reports) == 0 {
		return []string{"no backend contract reports found in " + backendReportDir}
	}
	slices.Sort(reports)
	var failures []string
	for _, report := range reports {
		relative, _ := filepath.Rel(root, report)
		data, err := os.ReadFile(report)
		if err != nil {
			failures = append(failures, relative+": unreadable")
			continue
		}
		for _, problem := range backendReportProblems(string(data)) {
			failures = append(failures, relative+": "+problem)
		}
	}
	return failures
}

func backendReportProblems(text string) []string {
	var problems []string
	if !strings.HasPrefix(text, "# Backend Contract Report:") {
		problems = append(problems, "title must start with '# Backend Contract Report:'")
	}
	sections := reportLevelTwoSections(text)
	for _, name := range reportSections {
		body, found := sections[name]
		switch {
		case !found:
			problems = append(problems, fmt.Sprintf("missing required '## %s' section", name))
		case body == "":
			problems = append(problems, fmt.Sprintf("'## %s' section must not be empty", name))
		}
	}
	if status := sections["Status"]; status != "" && !reportStatus.MatchString(status) {
		problems = append(problems, "Status must state SDK-facing backend contract status")
	}
	if priority := sections["Priority"]; priority != "" && !reportPriority.MatchString(priority) {
		problems = append(problems, "Priority must include P0, P1, P2, or P3")
	}
	if expected := sections["Expected Backend Capability"]; expected != "" &&
		!slices.ContainsFunc(reportCapabilityMarkers, func(marker string) bool { return strings.Contains(expected, marker) }) {
		problems = append(problems,
			"Expected Backend Capability must include suggested APIs, event fields, or runtime matching fields")
	}
	if verification := sections["Verification Needed"]; verification != "" && !reportVerification.MatchString(verification) {
		problems = append(problems,
			"Verification Needed must include concrete test, verifier, proof, or smoke expectations")
	}
	return problems
}

// reportLevelTwoSections maps each "##" heading to its trimmed text, which ends
// at the next heading of level two or higher.
func reportLevelTwoSections(text string) map[string]string {
	headings := reportHeading.FindAllStringSubmatchIndex(text, -1)
	sections := map[string]string{}
	for index, heading := range headings {
		if heading[3]-heading[2] != 2 {
			continue
		}
		end := len(text)
		for _, next := range headings[index+1:] {
			if next[3]-next[2] <= 2 {
				end = next[0]
				break
			}
		}
		sections[strings.TrimSpace(text[heading[4]:heading[5]])] = strings.TrimSpace(text[heading[1]:end])
	}
	return sections
}
