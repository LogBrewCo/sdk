package main

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	centralStatusURL  = "https://central.sonatype.com/api/v1/publisher/status"
	centralUnusable   = "Maven Central deployment status is unavailable."
	centralInvalid    = "Maven Central deployment status is invalid."
	deploymentInvalid = "Maven Central deployment identifier is invalid."
)

var (
	npmPackageName   = regexp.MustCompile(`^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$`)
	githubRepository = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	deploymentID     = regexp.MustCompile(`^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
	deploymentStates = []string{"PENDING", "VALIDATING", "VALIDATED", "PUBLISHING", "PUBLISHED", "FAILED"}
	publicationJobs  = []string{"crates.io package", "Maven Central package", "RubyGems package", "Packagist package", "Public registry verification", "Public SwiftPM verification", "npm packages"}
	// Each family's failed publication job, its sibling job, its failed step,
	// and the steps of a run that failed only in its public check; a step
	// that did not succeed starts with "=" and its conclusion.
	publicationContracts = map[string]struct {
		job, sibling, failed string
		steps                []string
	}{
		"pypi": {"PyPI packages", "NuGet package", "Verify public PyPI installs", []string{
			"Check out release ref", "Build Python distributions", "Create Python release manifest",
			"Verify packed Python distributions", "Upload Python release manifest", "Publish logbrew-sdk to PyPI",
			"Publish logbrew-fastapi to PyPI", "Publish logbrew-flask to PyPI", "Publish logbrew-django to PyPI",
			"Verify public PyPI packages", "=failure Verify public PyPI installs",
		}},
		"nuget": {"NuGet package / NuGet package", "PyPI packages", "Verify public NuGet package", []string{
			"Check out release ref", "Bind immutable release source", "Check out protected release control",
			"Bind protected release control", "Plan selected NuGet packages", "Validate NuGet release metadata",
			"Check NuGet version collision", "Pack NuGet package", "Publish NuGet package",
			"=failure Verify public NuGet package", "=skipped Verify public NuGet install",
		}},
	}
)

// noRedirects keeps a redirect response instead of following it.
func noRedirects(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// npmPlan reports which selected npm versions already exist and which
// packages have no registry page yet, without publishing anything.
func npmPlan(registry string, packages []string, transport http.RoundTripper) (string, error) {
	names, versions := []string{}, []string{}
	for _, raw := range packages {
		name, version, found := strings.Cut(raw, "=")
		if !found || !npmPackageName.MatchString(name) {
			return "", errors.New("invalid npm package selection: " + pyString(raw))
		}
		if version == "" || utf8.RuneCountInString(version) > 128 || strings.ContainsFunc(version, pyIsSpace) {
			return "", errors.New("invalid npm package version for " + name)
		}
		names, versions = append(names, name), append(versions, name+"@"+version)
	}
	parts, err := pyURLSplit(registry)
	switch {
	case len(names) == 0 || len(names) > 64:
		return "", errors.New("npm publication plan requires 1..64 selections")
	case len(slices.Compact(slices.Sorted(slices.Values(names)))) != len(names):
		return "", errors.New("npm publication plan contains duplicate package names")
	case err != nil || parts.scheme != "https" || parts.netloc == "" || strings.Contains(parts.netloc, "@") ||
		parts.query != "" || parts.fragment != "":
		return "", errors.New("npm registry must be a plain HTTPS URL")
	}
	registry = "https://" + parts.netloc + strings.TrimRight(parts.path, "/")
	existing, missing := []string{}, []string{}
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second}
	for index, name := range names {
		metadata, err := npmMetadata(client, registry+"/"+url.QueryEscape(name), name)
		if err != nil {
			return "", err
		}
		if _, found := metadata[strings.TrimPrefix(versions[index], name+"@")]; found {
			existing = append(existing, versions[index])
		} else if metadata == nil {
			missing = append(missing, name)
		}
	}
	return pyJSONText(map[string]any{"schemaVersion": 1, "registry": registry, "selectedVersions": versions,
		"existingVersions": existing, "missingPackagePages": missing}, "")
}

// npmMetadata reads one package's registry document and returns its
// versions, or nil when the package has no page.
func npmMetadata(client *http.Client, address, name string) (map[string]any, error) {
	request, err := http.NewRequest(http.MethodGet, address, nil)
	var response *http.Response
	if err == nil {
		request.Header.Set("Accept", "application/vnd.npm.install-v1+json, application/json")
		request.Header.Set("User-Agent", "LogBrew npm publication planner")
		response, err = client.Do(request)
	}
	if err != nil {
		return nil, errors.New("npm registry lookup failed for " + name)
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode == http.StatusNotFound:
		return nil, nil
	case response.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("npm registry returned HTTP %d for %s", response.StatusCode, name)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 16<<20+1))
	var payload any
	switch {
	case err != nil:
		return nil, errors.New("npm registry lookup failed for " + name)
	case len(data) > 16<<20:
		return nil, errors.New("npm registry metadata is too large for " + name)
	}
	if payload, err = decodePlanJSON(data); err != nil {
		return nil, errors.New("npm registry returned invalid JSON for " + name)
	}
	document, _ := payload.(map[string]any)
	if document == nil || !pyEqual(document["name"], name) {
		return nil, errors.New("npm registry returned mismatched metadata for " + name)
	}
	published, found := document["versions"].(map[string]any)
	if !found {
		return nil, errors.New("npm registry returned invalid versions metadata for " + name)
	}
	return published, nil
}

// workspacePackage is one npm package directory of the workspace.
type workspacePackage struct {
	peers                    map[string]string
	directory, name, version string
}

func loadWorkspacePackage(directory string) (workspacePackage, error) {
	path := pyPurePath(directory + "/package.json")
	data, err := os.ReadFile(path)
	var value any
	switch {
	case err != nil:
		err = pyOSErrorText(err, path)
	case !utf8.Valid(data):
		err = errors.New("not UTF-8")
	default:
		value, err = decodePlanJSON(data)
	}
	if err != nil {
		return workspacePackage{}, fmt.Errorf("cannot read npm manifest %s: %w", path, err)
	}
	manifest, _ := value.(map[string]any)
	name, _ := manifest["name"].(string)
	version, _ := manifest["version"].(string)
	raw, present := manifest["peerDependencies"]
	ranges, valid := raw.(map[string]any)
	peers := map[string]string{}
	for peer, value := range ranges {
		text, isText := value.(string)
		peers[peer], valid = text, valid && isText
	}
	switch {
	case manifest == nil || name == "":
		err = errors.New(path + ": name must be a non-empty string")
	case version == "":
		err = errors.New(path + ": version must be a non-empty string")
	case present && !valid:
		err = errors.New(path + ": peerDependencies must map names to ranges")
	}
	return workspacePackage{peers, directory, name, version}, err
}

// checkNPMWorkspace blocks an npm release whose selected packages need peer
// content that is neither selected first nor already published.
func checkNPMWorkspace(parsed checkArgs, transport http.RoundTripper, output, diagnostic io.Writer) int {
	packages, selected := map[string]workspacePackage{}, []string{}
	var failures []string
	err := func() error {
		for _, directory := range parsed.lists["workspace-dir"] {
			loaded, err := loadWorkspacePackage(directory)
			if err != nil {
				return err
			}
			packages[loaded.name] = loaded
		}
		if len(packages) != len(parsed.lists["workspace-dir"]) {
			return errors.New("workspace npm package names must be unique")
		}
		for _, directory := range parsed.lists["selected-dir"] {
			loaded, err := loadWorkspacePackage(directory)
			if err != nil {
				return err
			}
			selected = append(selected, loaded.name)
		}
		var err error
		failures, err = peerReleaseFailures(packages, selected, func(peer workspacePackage) (string, string, error) {
			local, err := bunPackSHA1(peer)
			if err != nil {
				return "", "", err
			}
			published, err := npmShasum(peer, parsed.values["registry"], transport)
			return local, published, err
		})
		return err
	}()
	if err != nil {
		return writeText(diagnostic, err.Error()+"\n", exitFailure)
	}
	if len(failures) > 0 {
		return writeText(diagnostic, strings.Join(failures, "\n")+"\n", exitFailure)
	}
	return writeText(output, "npm workspace peer release plan ok\n", exitOK)
}

// peerReleaseFailures checks each selected package's workspace peers: a
// selected peer must come first, and any other peer must already be
// published with the same packed bytes. identity returns a peer's local and
// published SHA-1, which is empty when the version is not published.
func peerReleaseFailures(packages map[string]workspacePackage, selected []string,
	identity func(workspacePackage) (string, string, error),
) ([]string, error) {
	failures, positions := []string{}, map[string]int{}
	for index, name := range selected {
		_, seen := positions[name]
		switch {
		case seen:
			failures = append(failures, "selected npm package "+name+" appears more than once")
			continue
		case packages[name].name == "":
			failures = append(failures, "selected npm package "+name+" is not in the workspace package set")
		}
		positions[name] = index
	}
	identities := map[string][2]string{}
	for _, consumerName := range selected {
		consumer, found := packages[consumerName]
		if !found {
			continue
		}
		who := consumer.name + "@" + consumer.version
		for _, peerName := range slices.Sorted(maps.Keys(consumer.peers)) {
			peer, found := packages[peerName]
			position, peerSelected := positions[peerName]
			peerRange, required := consumer.peers[peerName], peer.name+"@"+peer.version
			switch {
			case !found:
				continue
			case !caretAllows(peerRange, peer.version):
				failures = append(failures, fmt.Sprintf("%s peer %s range %s does not include workspace release %s", who,
					peerName, pyString(peerRange), peer.version))
				continue
			case peerSelected:
				if position >= positions[consumerName] {
					failures = append(failures, required+" must publish before "+who)
				}
				continue
			}
			if _, cached := identities[peerName]; !cached {
				local, published, err := identity(peer)
				if err != nil {
					return nil, err
				}
				identities[peerName] = [2]string{local, published}
			}
			switch shasums := identities[peerName]; {
			case shasums[1] == "":
				failures = append(failures, who+" requires "+required+", which is not published or could not be "+
					"verified; include that peer before its consumer")
			case shasums[0] != shasums[1]:
				failures = append(failures, who+" depends on unpublished workspace content for "+required+
					"; bump and include that peer before its consumer")
			}
		}
	}
	return failures, nil
}

// bunPackSHA1 packs a package with bun and returns the tarball's SHA-1, which
// npm records as dist.shasum.
func bunPackSHA1(peer workspacePackage) (string, error) {
	directory, err := os.MkdirTemp("", "logbrew-npm-pack-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(directory)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	artifact := filepath.Join(directory, "package.tgz")
	command := exec.CommandContext(ctx, "bun", "pm", "pack", "--filename", artifact, "--ignore-scripts", "--quiet")
	command.Dir = peer.directory
	err = command.Run()
	data, readError := os.ReadFile(artifact)
	if err != nil || readError != nil {
		return "", errors.New("cannot pack " + peer.name + "@" + peer.version)
	}
	digest := sha1.Sum(data)
	return hex.EncodeToString(digest[:]), nil
}

// npmShasum reads the published dist.shasum of a package version, or "" when
// the version is not published.
func npmShasum(peer workspacePackage, registry string, transport http.RoundTripper) (string, error) {
	failure := errors.New("cannot verify " + peer.name + "@" + peer.version)
	client := &http.Client{Transport: transport, Timeout: time.Minute}
	response, err := client.Get(strings.TrimRight(registry, "/") + "/" + pyQuote(peer.name, "@") + "/" +
		pyQuote(peer.version, ""))
	if err != nil {
		return "", failure
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 16<<20+1))
	var payload any
	if err == nil && len(data) <= 16<<20 {
		payload, err = decodePlanJSON(data)
	}
	switch {
	case response.StatusCode == http.StatusNotFound:
		return "", nil
	case response.StatusCode/100 != 2 || err != nil || len(data) > 16<<20:
		return "", failure
	}
	document, _ := payload.(map[string]any)
	dist, _ := document["dist"].(map[string]any)
	shasum, isText := dist["shasum"].(string)
	switch {
	case dist["shasum"] != nil && !isText:
		return "", failure
	case utf8.RuneCountInString(shasum) != 40:
		return "", errors.New("npm view returned an invalid shasum for " + peer.name + "@" + peer.version)
	}
	return shasum, nil
}

// verifyPublicationRun checks through the GitHub API that a publication run
// of the exact workflow and source failed only in its public check.
func verifyPublicationRun(values map[string]string, runID int64, token string, transport http.RoundTripper) bool {
	repository, family := values["repository"], values["family"]
	if !githubRepository.MatchString(repository) || runID <= 0 || !sourceCommitSHA.MatchString(values["workflow-sha"]) ||
		!sourceCommitSHA.MatchString(values["source-sha"]) || token == "" {
		return false
	}
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second,
		CheckRedirect: noRedirects}
	base := "https://api.github.com/repos/" + repository + "/actions/runs/" + strconv.FormatInt(runID, 10)
	run, valid := githubJSON(client, base, token)
	if !valid {
		return false
	}
	jobs, valid := githubJSON(client, base+"/jobs?per_page=100", token)
	workflowSHA := values["workflow-sha"]
	head, _ := run["head_repository"].(map[string]any)
	references, present := run["referenced_workflows"].([]any)
	if _, found := run["referenced_workflows"]; !found {
		references, present = []any{}, true
	}
	var reference map[string]any
	if len(references) == 1 {
		reference, _ = references[0].(map[string]any)
	}
	expected := map[string]any{"id": json.Number(strconv.FormatInt(runID, 10)), "event": "workflow_dispatch",
		"path": ".github/workflows/publish-packages.yml", "head_branch": "main", "head_sha": workflowSHA,
		"display_title": "Publish " + family + " from " + values["source-sha"], "conclusion": "failure",
		"run_attempt": json.Number("1")}
	for key, value := range expected {
		valid = valid && pyEqual(run[key], value)
	}
	return valid && head != nil && pyEqual(head["full_name"], repository) && present && reference != nil &&
		pyEqual(reference["path"], repository+"/.github/workflows/publish-nuget.yml@"+workflowSHA) &&
		pyEqual(reference["ref"], "refs/heads/main") && pyEqual(reference["sha"], workflowSHA) &&
		validPublicationJobs(jobs, family)
}

func githubJSON(client *http.Client, address, token string) (map[string]any, bool) {
	request, _ := http.NewRequest(http.MethodGet, address, nil)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := client.Do(request)
	if err != nil {
		return nil, false
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20+1))
	var payload any
	if err == nil && response.StatusCode == http.StatusOK && len(data) <= 2<<20 {
		payload, err = decodePlanJSON(data)
	}
	document, valid := payload.(map[string]any)
	return document, valid && err == nil
}

func validPublicationJobs(payload map[string]any, family string) bool {
	contract := publicationContracts[family]
	expected := append(slices.Clone(publicationJobs), contract.job, contract.sibling)
	jobs, valid := payload["jobs"].([]any)
	valid = valid && pyEqual(payload["total_count"], json.Number(strconv.Itoa(len(jobs)))) && len(jobs) == len(expected)
	names, steps := map[string]bool{}, []any(nil)
	for _, job := range jobs {
		record, _ := job.(map[string]any)
		name, _ := record["name"].(string)
		conclusion := record["conclusion"]
		valid = valid && slices.Contains(expected, name) && (name == contract.job && pyEqual(conclusion, "failure") ||
			name != contract.job && (pyEqual(conclusion, "skipped") || pyEqual(conclusion, "neutral")))
		names[name] = true
		if name == contract.job {
			list, isList := record["steps"].([]any)
			steps, valid = list, valid && isList
		}
	}
	results := map[string]string{}
	for _, step := range steps {
		record, _ := step.(map[string]any)
		name, named := record["name"].(string)
		conclusion, concluded := record["conclusion"].(string)
		_, repeated := results[name]
		valid = valid && named && concluded && !repeated
		results[name] = conclusion
	}
	for _, step := range contract.steps {
		conclusion, name := "success", step
		if strings.HasPrefix(step, "=") {
			conclusion, name, _ = strings.Cut(step[1:], " ")
		}
		valid = valid && results[name] == conclusion
	}
	failed := 0
	for _, conclusion := range results {
		failed += map[bool]int{true: 1}[conclusion == "failure"]
	}
	return valid && len(names) == len(expected) && failed == 1
}

// mavenDeployment privately stores the deployment ID of a Maven Central
// upload, or waits until that deployment is published.
func mavenDeployment(command string, parsed checkArgs, tools releaseTools, output, diagnostic io.Writer) int {
	path := pyPurePath(parsed.values["deployment-id-file"])
	if command == "maven-deployment capture" {
		raw, _ := io.ReadAll(io.LimitReader(tools.input, 129))
		if err := captureDeployment(raw, path); err != "" {
			return writeText(diagnostic, err+"\n", exitFailure)
		}
		return writeText(output, "Maven Central deployment submitted.\n", exitOK)
	}
	var limits [3]int64
	for index, name := range []string{"timeout-seconds", "poll-interval-seconds", "request-timeout-seconds"} {
		var valid bool
		if limits[index], valid = pyInt(parsed.values[name], 10, false); !valid {
			return writeText(diagnostic, releaseChecksUsage, exitUsage)
		}
	}
	message, code := waitDeployment(path, limits, parsed.switches["once"], tools)
	if code == exitFailure {
		return writeText(diagnostic, message+"\n", code)
	}
	return writeText(output, message+"\n", code)
}

func captureDeployment(raw []byte, path string) string {
	if !deploymentID.Match(raw) || !strings.HasPrefix(path, "/") || !pyIsDir(filepath.Dir(path)) {
		return deploymentInvalid
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return "Maven Central deployment identifier could not be stored."
	}
	_, err = file.Write(append(raw, '\n'))
	if err = errors.Join(file.Chmod(0o600), err, file.Sync(), file.Close()); err != nil {
		_ = os.Remove(path)
		return "Maven Central deployment identifier could not be stored."
	}
	return ""
}

func readDeploymentID(path string) (string, string) {
	if !strings.HasPrefix(path, "/") {
		return "", deploymentInvalid
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", "Maven Central deployment identifier is unavailable."
	}
	defer file.Close()
	var status syscall.Stat_t
	if syscall.Fstat(int(file.Fd()), &status) != nil || status.Mode&syscall.S_IFMT != syscall.S_IFREG ||
		status.Mode&0o7777 != 0o600 || int(status.Uid) != os.Getuid() || status.Size > 128 {
		return "", deploymentInvalid
	}
	raw, _ := io.ReadAll(io.LimitReader(file, 129))
	if id := strings.TrimSuffix(string(raw), "\n"); deploymentID.MatchString(id) {
		return id, ""
	}
	return "", deploymentInvalid
}

func waitDeployment(path string, limits [3]int64, once bool, tools releaseTools) (string, int) {
	id, failure := readDeploymentID(path)
	if failure != "" {
		return failure, exitFailure
	}
	if limits[0] <= 0 || limits[0] > 7_200 || limits[1] <= 0 || limits[1] > 300 {
		return "Maven Central deployment wait is invalid.", exitFailure
	}
	deadline := tools.now().Add(time.Duration(limits[0]) * time.Second)
	for {
		state, failure := deploymentState(id, limits[2], tools.transport)
		switch {
		case failure != "":
			return failure, exitFailure
		case state == "" && once:
			return centralUnusable, exitFailure
		case state == "PUBLISHED":
			return "Maven Central deployment published.", exitOK
		case state == "FAILED":
			return "Maven Central deployment failed.", exitFailure
		case once:
			return "Maven Central deployment is still processing.", 3
		}
		remaining := deadline.Sub(tools.now())
		if remaining <= 0 {
			return "Maven Central deployment did not finish before timeout.", exitFailure
		}
		tools.sleep(min(time.Duration(limits[1])*time.Second, remaining))
	}
}

// deploymentState fetches one deployment's state; an empty state with no
// failure is a retryable error.
func deploymentState(id string, timeout int64, transport http.RoundTripper) (string, string) {
	name, value := os.Getenv("CENTRAL_PORTAL_USERNAME"), os.Getenv("CENTRAL_PORTAL_PASSWORD")
	if name == "" || value == "" || timeout < 1 || timeout > 60 {
		return "", centralUnusable
	}
	request, _ := http.NewRequest(http.MethodPost, centralStatusURL+"?id="+id, http.NoBody)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Authorization", "Bearer "+base64.StdEncoding.EncodeToString([]byte(name+":"+value)))
	client := &http.Client{Transport: transport, Timeout: time.Duration(timeout) * time.Second,
		CheckRedirect: noRedirects}
	response, err := client.Do(request)
	if err != nil {
		return "", ""
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 65_537))
	switch {
	case response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 ||
		response.StatusCode/100 == 2 && err != nil:
		return "", ""
	case response.StatusCode/100 != 2:
		return "", centralUnusable
	}
	payload, err := decodePlanJSON(data)
	document, _ := payload.(map[string]any)
	state, _ := document["deploymentState"].(string)
	if len(data) == 0 || len(data) > 65_536 || err != nil || !pyEqual(document["deploymentId"], id) ||
		!slices.Contains(deploymentStates, state) {
		return "", centralInvalid
	}
	return state, ""
}
