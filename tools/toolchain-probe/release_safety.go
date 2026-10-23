package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os/exec"
	"slices"
	"strings"
)

const releaseSafetyMode = "github-release-safety"

type releaseSafetyOptions struct {
	repo, branch, environment, context           string
	protectionFile, summaryFile, environmentFile string
	allowSummary                                 bool
}

// checkReleaseSafety fails unless the branch and release environment settings
// that guard package publishing are in place. The api function returns a
// GitHub REST response body.
func checkReleaseSafety(arguments []string, api func(string) ([]byte, error), output, diagnostic io.Writer) int {
	options, valid := parseReleaseSafety(arguments, diagnostic)
	if !valid {
		return exitUsage
	}
	failures, usedSummary, err := releaseSafetyFindings(options, api)
	if err != nil {
		return writeText(diagnostic, "GitHub release safety check failed: "+err.Error()+"\n", exitFailure)
	}
	if len(failures) > 0 {
		return writeText(diagnostic, "GitHub release safety check failed:\n- "+strings.Join(failures, "\n- ")+"\n", exitFailure)
	}
	if usedSummary {
		return writeText(output, fmt.Sprintf("GitHub release safety ok: public summary shows %s is protected and requires %s; "+
			"%s deploys only from protected branches. Run without --allow-public-branch-summary for full "+
			"strict/force-push/deletion verification.\n", options.branch, quoted(options.context), quoted(options.environment)), exitOK)
	}
	return writeText(output, fmt.Sprintf("GitHub release safety ok: %s requires %s, force pushes/deletion are disabled, "+
		"and %s deploys only from protected branches.\n", options.branch, quoted(options.context), quoted(options.environment)), exitOK)
}

func parseReleaseSafety(arguments []string, diagnostic io.Writer) (releaseSafetyOptions, bool) {
	var options releaseSafetyOptions
	flags := flag.NewFlagSet(releaseSafetyMode, flag.ContinueOnError)
	flags.SetOutput(diagnostic)
	flags.StringVar(&options.repo, "repo", "LogBrewCo/sdk", "GitHub repository")
	flags.StringVar(&options.branch, "branch", "main", "protected branch")
	flags.StringVar(&options.environment, "environment", "release", "GitHub Actions environment")
	flags.StringVar(&options.context, "required-context", "Contract checks", "required status check")
	flags.StringVar(&options.protectionFile, "branch-protection-json", "", "branch protection fixture")
	flags.StringVar(&options.summaryFile, "branch-summary-json", "", "public branch summary fixture")
	flags.StringVar(&options.environmentFile, "environment-json", "", "environment fixture")
	flags.BoolVar(&options.allowSummary, "allow-public-branch-summary", false,
		"fall back to the public branch summary, which does not show strict mode, force-push, or deletion protection")
	if flags.Parse(arguments) != nil || flags.NArg() != 0 || (options.protectionFile != "" && options.summaryFile != "") {
		_ = writeText(diagnostic, "usage: github-release-safety [flags]; pass at most one branch fixture\n", exitUsage)
		return options, false
	}
	return options, true
}

func releaseSafetyFindings(options releaseSafetyOptions, api func(string) ([]byte, error)) ([]string, bool, error) {
	branchPath := "repos/" + options.repo + "/branches/" + options.branch
	var branch any
	var err error
	usedSummary := options.summaryFile != ""
	switch {
	case usedSummary:
		branch, err = releaseSafetyFixture(options.summaryFile)
	case options.protectionFile != "":
		branch, err = releaseSafetyFixture(options.protectionFile)
	default:
		branch, err = releaseSafetyAPI(api, branchPath+"/protection")
		var apiError *releaseAPIError
		if options.allowSummary && errors.As(err, &apiError) {
			usedSummary = true
			branch, err = releaseSafetyAPI(api, branchPath)
		}
	}
	if err != nil {
		return nil, usedSummary, err
	}
	var environment any
	if options.environmentFile != "" {
		environment, err = releaseSafetyFixture(options.environmentFile)
	} else {
		environment, err = releaseSafetyAPI(api, "repos/"+options.repo+"/environments/"+options.environment)
	}
	if err != nil {
		return nil, usedSummary, err
	}
	var failures []string
	if usedSummary {
		failures = branchSummaryFailures(branch, options.branch, options.context)
	} else {
		failures = branchProtectionFailures(branch, options.branch, options.context)
	}
	return append(failures, environmentFailures(environment, options.environment)...), usedSummary, nil
}

type releaseAPIError struct{ path, detail string }

func (err *releaseAPIError) Error() string { return "gh api " + err.path + " failed: " + err.detail }

func releaseSafetyAPI(api func(string) ([]byte, error), path string) (any, error) {
	data, err := api(path)
	if err != nil {
		return nil, &releaseAPIError{path, err.Error()}
	}
	if document, valid := decodeCheckDocument(data); valid {
		return document, nil
	}
	return nil, errors.New("gh api " + path + " returned invalid JSON")
}

func releaseSafetyFixture(path string) (any, error) {
	if data, readable := readCheckFile(path); readable {
		if document, valid := decodeCheckDocument(data); valid {
			return document, nil
		}
	}
	return nil, errors.New(path + " is not a readable JSON document")
}

// ghAPI reads one GitHub REST resource with the GitHub CLI and its credentials.
func ghAPI(path string) ([]byte, error) {
	if _, err := exec.LookPath("gh"); err != nil {
		return nil, errors.New("GitHub CLI `gh` is required when fixture JSON files are not provided")
	}
	command := exec.Command("gh", "api", path)
	var stderr strings.Builder
	command.Stderr = &stderr
	data, err := command.Output()
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = strings.TrimSpace(string(data))
		}
		return nil, errors.New(detail)
	}
	return data, nil
}

func quoted(value string) string { return "'" + value + "'" }

func member(value any, key string) any {
	object, _ := value.(map[string]any)
	return object[key]
}

func isTrue(value any) bool { flag, ok := value.(bool); return ok && flag }

func statusContexts(protection any) []string {
	checks := member(protection, "required_status_checks")
	var contexts []string
	for _, field := range []string{"contexts", "checks"} {
		items, _ := member(checks, field).([]any)
		for _, item := range items {
			if field == "checks" {
				item = member(item, "context")
			}
			if text, ok := item.(string); ok {
				contexts = append(contexts, text)
			}
		}
	}
	return contexts
}

func branchProtectionFailures(protection any, branch, context string) []string {
	if _, ok := protection.(map[string]any); !ok {
		return []string{branch + ": branch protection response is not an object"}
	}
	var failures []string
	if checks, ok := member(protection, "required_status_checks").(map[string]any); !ok {
		failures = append(failures, branch+": required status checks are not enabled")
	} else {
		if !isTrue(checks["strict"]) {
			failures = append(failures, branch+": required status checks must be strict")
		}
		if !slices.Contains(statusContexts(protection), context) {
			failures = append(failures, branch+": required status check "+quoted(context)+" is missing")
		}
	}
	for _, setting := range [][3]string{
		{"allow_force_pushes", "force-push protection state is missing", "force pushes must stay disabled"},
		{"allow_deletions", "branch-deletion protection state is missing", "branch deletion must stay disabled"},
	} {
		enabled, known := member(member(protection, setting[0]), "enabled").(bool)
		if !known {
			failures = append(failures, branch+": "+setting[1])
		} else if enabled {
			failures = append(failures, branch+": "+setting[2])
		}
	}
	return failures
}

func branchSummaryFailures(summary any, branch, context string) []string {
	if _, ok := summary.(map[string]any); !ok {
		return []string{branch + ": branch summary response is not an object"}
	}
	var failures []string
	if !isTrue(member(summary, "protected")) {
		failures = append(failures, branch+": branch must be protected")
	}
	protection := member(summary, "protection")
	if !isTrue(member(protection, "enabled")) {
		return append(failures, branch+": public branch protection summary is missing")
	}
	if _, ok := member(protection, "required_status_checks").(map[string]any); !ok {
		failures = append(failures, branch+": required status checks are not visible in public summary")
	} else if !slices.Contains(statusContexts(protection), context) {
		failures = append(failures, branch+": required status check "+quoted(context)+" is missing")
	}
	return failures
}

func environmentFailures(environment any, name string) []string {
	if _, ok := environment.(map[string]any); !ok {
		return []string{name + ": environment response is not an object"}
	}
	var failures []string
	if actual, _ := member(environment, "name").(string); actual != name {
		failures = append(failures, name+": environment name did not match response")
	}
	if policy, ok := member(environment, "deployment_branch_policy").(map[string]any); !ok {
		failures = append(failures, name+": deployment branch policy is not enabled")
	} else {
		if !isTrue(policy["protected_branches"]) {
			failures = append(failures, name+": deployments must be restricted to protected branches")
		}
		if custom, known := policy["custom_branch_policies"].(bool); !known || custom {
			failures = append(failures, name+": custom branch policies should stay disabled")
		}
	}
	rules, _ := member(environment, "protection_rules").([]any)
	if !slices.ContainsFunc(rules, func(rule any) bool { return member(rule, "type") == "branch_policy" }) {
		failures = append(failures, name+": branch policy protection rule is missing")
	}
	return failures
}
