package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"maps"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	registryPublicationMode = "registry-publication"
	registryUsage           = "usage: registry-publication [--target TARGET]... [--version VERSION] " +
		"[--npm-package PACKAGE]... [--npm-version|--pypi-version|--nuget-version|--maven-version PACKAGE=VERSION]... " +
		"[--maven-artifact ARTIFACT]... [--maven-plan PLAN --maven-plan-scope selected|dependencies] " +
		"[--include-unity-npm] [--include-pypi-extras] [--include-crates] [--include-packagist] [--include-maven] " +
		"[--include-openupm] [--include-go] [--require-npm-provenance] [--require-released-package-set] " +
		"[--expect-absent] [--timeout SECONDS] [--retries COUNT] [--retry-delay SECONDS] [--max-wait-seconds SECONDS]\n"
	unityPackage = "co.logbrew.unity"
	// pyMaxSeconds is the longest wait Python's time functions accept.
	pyMaxSeconds = float64(math.MaxInt64) / 1e9
)

var (
	registryTargets = []string{"all", "npm", "pypi", "rubygems", "nuget", "packagist", "crates", "maven", "openupm", "go"}
	registryNPM     = []string{"@logbrew/amqplib", "@logbrew/angular", "@logbrew/aws-sqs", "@logbrew/browser",
		"@logbrew/bullmq", "@logbrew/express", "@logbrew/fastify", "@logbrew/kafkajs", "@logbrew/nestjs",
		"@logbrew/next", "@logbrew/node", "@logbrew/prisma", "@logbrew/react", "@logbrew/react-native",
		"@logbrew/sdk", "@logbrew/svelte", "@logbrew/vue"}
	// registryPyPI lists the core package first, then the extras.
	registryPyPI   = []string{"logbrew-sdk", "logbrew-fastapi", "logbrew-flask", "logbrew-django"}
	registryMaven  = []string{"logbrew-sdk", "logbrew-kotlin", "logbrew-kotlin-okhttp"}
	registrySwitch = []string{"include-unity-npm", "require-npm-provenance", "include-pypi-extras", "include-crates",
		"include-packagist", "include-maven", "include-openupm", "include-go", "require-released-package-set",
		"expect-absent"}
	pyFloatPattern = regexp.MustCompile(`^[+-]?(?:(?i:inf|infinity|nan)|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|` +
		`\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)$`)
)

type registryCheck struct {
	label, url, family string
	versions           func(any) []string
	text               bool
}

// registryRun holds the parsed options of one registry-publication command.
type registryRun struct {
	transport                   http.RoundTripper
	sleep                       func(float64)
	clock                       func() float64
	targets, npmPackages        []string
	version                     string
	switches                    map[string]bool
	versions                    map[string]map[string]string
	order                       map[string][]string
	timeout, retryDelay, wait   float64
	retries                     int64
	mavenArtifacts, nugetIDs    []string
	rubygems, packagist, crates string
	maven                       string
	plan                        bool
}

// checkRegistryPublication verifies that public registries expose, or do not
// yet expose, the expected package versions.
func checkRegistryPublication(arguments []string, transport http.RoundTripper, sleep func(float64),
	clock func() float64, output, diagnostic io.Writer,
) (code int) {
	defer func() {
		if value := recover(); value != nil {
			stop := value.(nativeStop)
			code = writeText(diagnostic, stop.message+"\n", stop.code)
		}
	}()
	catalog, err := loadReleaseCatalog(releaseCatalogText)
	if err != nil {
		return writeText(diagnostic, "release catalog is invalid: "+err.Error()+"\n", exitFailure)
	}
	run := &registryRun{transport: transport, sleep: sleep, clock: clock, nugetIDs: catalog.nugetIDs(),
		rubygems: catalog.RubyGems, packagist: catalog.Packagist, crates: catalog.Rust, maven: catalog.Maven,
		switches: map[string]bool{}, versions: map[string]map[string]string{}, order: map[string][]string{}}
	message, err := run.parse(arguments, catalog.PublicVersion)
	if errors.Is(err, flag.ErrHelp) {
		return writeText(output, registryUsage, exitOK)
	}
	if err != nil {
		return writeText(diagnostic, registryUsage, exitUsage)
	}
	if message != "" {
		return writeText(diagnostic, registryUsage+registryPublicationMode+": error: "+message+"\n", exitUsage)
	}
	failures := []string{}
	for _, check := range run.checks() {
		version := run.versions[check.family][check.label]
		if _, found := run.versions[check.family][check.label]; !found {
			version = map[string]string{"rubygems": run.rubygems, "packagist": run.packagist, "crates": run.crates,
				"maven": run.maven}[check.family]
			version = cmpOr(version, run.version)
		}
		expected := []string{version}
		if check.family != "maven" {
			stripped := strings.TrimPrefix(version, "v")
			expected = []string{stripped, "v" + stripped}
		}
		switch {
		case run.switches["expect-absent"]:
			failures = append(failures, run.absent(check, expected)...)
		case run.switches["require-npm-provenance"] && check.family == "npm":
			failures = append(failures, run.present(npmProvenanceCheck(check.label, version), []string{version})...)
		default:
			failures = append(failures, run.present(check, expected)...)
		}
	}
	if slices.Contains(run.targets, "go") || slices.Contains(run.targets, "all") && run.switches["include-go"] {
		failures = append(failures, registryGoModule(run.version)...)
	}
	if len(failures) > 0 {
		return writeText(diagnostic, strings.Join(failures, "\n")+"\n", exitFailure)
	}
	return writeText(output, run.summary()+"\n", exitOK)
}

// parse reads the options; err is an option syntax error and message a
// rejected combination, both usage errors.
func (run *registryRun) parse(arguments []string, publicVersion string) (string, error) {
	flags := flag.NewFlagSet(registryPublicationMode, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	version := flags.String("version", publicVersion, "")
	plan, scope := flags.String("maven-plan", "", ""), flags.String("maven-plan-scope", "", "")
	numbers := map[string]*string{}
	for name, fallback := range map[string]string{"timeout": "20", "retries": "6", "retry-delay": "10",
		"max-wait-seconds": "0"} {
		numbers[name] = flags.String(name, fallback, "")
	}
	switches := map[string]*bool{}
	for _, name := range registrySwitch {
		switches[name] = flags.Bool(name, false, "")
	}
	lists := map[string]*versionFlags{}
	for _, name := range []string{"target", "npm-package", "maven-artifact", "npm-version", "pypi-version",
		"nuget-version", "maven-version"} {
		lists[name] = &versionFlags{}
		flags.Var(lists[name], name, "")
	}
	if err := flags.Parse(arguments); err != nil {
		return "", err
	}
	errUsage := errors.New("usage")
	set := map[string]bool{}
	flags.Visit(func(used *flag.Flag) { set[used.Name] = true })
	var parsed [3]bool
	run.timeout, parsed[0] = pyFloat(*numbers["timeout"])
	run.retryDelay, parsed[1] = pyFloat(*numbers["retry-delay"])
	run.wait, parsed[2] = pyFloat(*numbers["max-wait-seconds"])
	retries, retriesParsed := pyInt(*numbers["retries"], 10, false)
	inside := func(values []string, choices []string) bool {
		return !slices.ContainsFunc(values, func(value string) bool { return !slices.Contains(choices, value) })
	}
	if flags.NArg() > 0 || parsed != [3]bool{true, true, true} || !retriesParsed ||
		!inside(*lists["target"], registryTargets) || !inside(*lists["npm-package"], registryNPM) ||
		!inside(*lists["maven-artifact"], registryMaven) || set["maven-plan-scope"] &&
		!slices.Contains([]string{"selected", "dependencies"}, *scope) {
		return "", errUsage
	}
	for name, value := range switches {
		run.switches[name] = *value
	}
	run.version, run.retries, run.npmPackages = *version, retries, *lists["npm-package"]
	run.targets, run.mavenArtifacts = cmpOrSlice(*lists["target"], []string{"all"}), *lists["maven-artifact"]
	has := func(target string) bool {
		return slices.Contains(run.targets, target) || slices.Contains(run.targets, "all")
	}
	maven := slices.Equal(run.targets, []string{"maven"})
	for _, rule := range []struct {
		broken  bool
		message string
	}{
		{len(run.npmPackages) > 0 && !has("npm"), "--npm-package requires --target npm or --target all"},
		{run.switches["require-npm-provenance"] && !has("npm"),
			"--require-npm-provenance requires --target npm or --target all"},
		{len(*lists["pypi-version"]) > 0 && !has("pypi"), "--pypi-version requires --target pypi or --target all"},
		{len(*lists["nuget-version"]) > 0 && !has("nuget"), "--nuget-version requires --target nuget or --target all"},
		{run.switches["expect-absent"] && !maven && !slices.Equal(run.targets, []string{"nuget"}),
			"--expect-absent requires exactly --target nuget or --target maven"},
		{len(run.mavenArtifacts) > 0 && !has("maven"), "--maven-artifact requires --target maven or --target all"},
		{len(*lists["maven-version"]) > 0 && !has("maven"), "--maven-version requires --target maven or --target all"},
		{set["maven-plan"] && !has("maven"), "--maven-plan requires --target maven or --target all"},
		{set["maven-plan"] != set["maven-plan-scope"], "--maven-plan and --maven-plan-scope must be used together"},
		{set["maven-plan"] && len(run.mavenArtifacts)+len(*lists["maven-version"]) > 0,
			"--maven-plan cannot be combined with Maven artifact or version overrides"},
		{run.switches["expect-absent"] && maven && (!set["maven-plan"] || *scope != "selected"),
			"Maven --expect-absent requires the selected Maven release plan"},
	} {
		if rule.broken {
			return rule.message, nil
		}
	}
	mavenLabels := make([]string, len(registryMaven))
	for index, artifact := range registryMaven {
		mavenLabels[index] = "co.logbrew:" + artifact
	}
	for _, family := range []struct{ name, flag, label string }{{"npm", "npm-version", "npm"},
		{"pypi", "pypi-version", "PyPI"}, {"nuget", "nuget-version", "NuGet"}, {"maven", "maven-version", "Maven"}} {
		allowed := map[string][]string{"npm": append(slices.Clone(registryNPM), unityPackage), "pypi": registryPyPI,
			"nuget": run.nugetIDs, "maven": mavenLabels}[family.name]
		run.versions[family.name] = map[string]string{}
		for _, raw := range *lists[family.flag] {
			name, value, found := strings.Cut(raw, "=")
			name, value = pyStrip(name), pyStrip(value)
			switch {
			case !found || name == "" || value == "":
				return fmt.Sprintf("expected %s package version in name=version form, got %s", family.label,
					pyString(raw)), nil
			case !slices.Contains(allowed, name):
				return "unknown " + family.label + " package: " + name, nil
			case slices.Contains(run.order[family.name], name):
				return "duplicate " + family.label + " package: " + name, nil
			}
			run.versions[family.name][name] = value
			run.order[family.name] = append(run.order[family.name], name)
		}
	}
	if run.switches["require-released-package-set"] {
		required := registryNPM
		if run.switches["include-unity-npm"] {
			required = append(slices.Clone(registryNPM), unityPackage)
		}
		same := func(names, want []string) bool {
			return slices.Equal(slices.Sorted(slices.Values(names)), slices.Sorted(slices.Values(want)))
		}
		if !slices.Contains(run.targets, "all") || len(run.npmPackages) > 0 || !same(run.order["npm"], required) ||
			!same(run.order["nuget"], run.nugetIDs) {
			return "released package verification requires exact npm and NuGet maps", nil
		}
	}
	if run.plan = set["maven-plan"]; run.plan {
		var message string
		run.mavenArtifacts, run.versions["maven"], message = registryMavenPlan(*plan, *scope)
		return message, nil
	}
	return "", nil
}

// registryMavenPlan reads the exact Maven coordinates of a release plan.
func registryMavenPlan(path, scope string) ([]string, map[string]string, string) {
	data, err := os.ReadFile(pyPath(path))
	if err != nil {
		return nil, nil, "invalid Maven release plan: " + pyErrorName(err)
	}
	if !utf8.Valid(data) {
		panic(nativeStop{exitFailure, "Maven release plan is not UTF-8"})
	}
	decoded, err := decodePlanJSON(data)
	if err != nil {
		return nil, nil, "invalid Maven release plan: JSONDecodeError"
	}
	plan, _ := decoded.(map[string]any)
	if plan == nil || !pyEqual(plan["schemaVersion"], json.Number("1")) {
		return nil, nil, "invalid Maven release plan schema"
	}
	key := map[bool]string{true: "selected", false: "externalDependencies"}[scope == "selected"]
	entries, valid := plan[key].([]any)
	artifacts, versions := []string{}, map[string]string{}
	for _, raw := range entries {
		entry, _ := raw.(map[string]any)
		artifact, _ := entry["artifactId"].(string)
		version, _ := entry["version"].(string)
		valid = valid && slices.Contains(registryMaven, artifact) && entry["coordinate"] == "co.logbrew:"+artifact &&
			version != "" && !slices.Contains(artifacts, artifact)
		artifacts, versions["co.logbrew:"+artifact] = append(artifacts, artifact), version
	}
	switch {
	case !valid:
		return nil, nil, "invalid Maven release plan " + key
	case len(artifacts) == 0 && scope == "selected":
		return nil, nil, "Maven release plan has no selected artifacts"
	}
	return artifacts, versions, ""
}

func (run *registryRun) checks() []registryCheck {
	has := func(target string) bool {
		return slices.Contains(run.targets, target) ||
			slices.Contains(run.targets, "all") && (slices.Contains([]string{"npm", "pypi", "rubygems", "nuget"}, target) ||
				run.switches["include-"+target])
	}
	checks := []registryCheck{}
	if has("npm") {
		packages := cmpOrSlice(run.npmPackages, cmpOrSlice(run.order["npm"], registryNPM))
		if run.switches["include-unity-npm"] && !slices.Contains(packages, unityPackage) {
			packages = append(slices.Clone(packages), unityPackage)
		}
		for _, name := range packages {
			checks = append(checks, registryCheck{name, "https://registry.npmjs.org/" + pyQuote(name, ""), "npm", npmVersions,
				false})
		}
	}
	if has("pypi") {
		packages := registryPyPI[:1]
		if run.switches["include-pypi-extras"] {
			packages = registryPyPI
		}
		for _, name := range packages {
			checks = append(checks, registryCheck{name, "https://pypi.org/pypi/" + name + "/json", "pypi", pypiVersions,
				false})
		}
	}
	if has("rubygems") {
		checks = append(checks, registryCheck{"logbrew-sdk", "https://rubygems.org/api/v1/gems/logbrew-sdk.json",
			"rubygems", func(payload any) []string { return nonEmpty(field(payload, "version")) }, false})
	}
	if has("nuget") {
		for _, id := range cmpOrSlice(run.order["nuget"], run.nugetIDs) {
			checks = append(checks, registryCheck{id, "https://api.nuget.org/v3-flatcontainer/" + strings.ToLower(id) +
				"/index.json", "nuget", nugetVersions, false})
		}
	}
	if has("packagist") {
		checks = append(checks, registryCheck{"logbrew/sdk", "https://repo.packagist.org/p2/logbrew/sdk.json",
			"packagist", packagistVersions, false})
	}
	if has("crates") {
		checks = append(checks, registryCheck{"logbrew", "https://index.crates.io/lo/gb/logbrew", "crates", cratesVersions,
			true})
	}
	if has("maven") {
		artifacts := run.mavenArtifacts
		if !run.plan {
			artifacts = cmpOrSlice(artifacts, registryMaven)
		}
		for _, artifact := range artifacts {
			checks = append(checks, registryCheck{"co.logbrew:" + artifact, "https://repo1.maven.org/maven2/co/logbrew/" +
				artifact + "/maven-metadata.xml", "maven", mavenVersions, true})
		}
	}
	if has("openupm") {
		checks = append(checks, registryCheck{unityPackage, "https://package.openupm.com/" + unityPackage, "openupm",
			npmVersions, false})
	}
	return checks
}

func npmProvenanceCheck(name, version string) registryCheck {
	return registryCheck{name + " provenance", "https://registry.npmjs.org/" + pyQuote(name, "") + "/" + pyQuote(version, ""),
		"npm-provenance", npmProvenanceVersions, false}
}

// present waits until a registry lists one of the expected versions.
func (run *registryRun) present(check registryCheck, expected []string) []string {
	if run.wait > 0 {
		deadline, delay := run.clock()+run.wait, max(run.retryDelay, 0.5)
		failures := run.attempt(check, expected)
		for remaining := deadline - run.clock(); failures != nil && remaining > 0; remaining = deadline - run.clock() {
			run.pause(min(delay, remaining))
			delay = min(delay*2, 30)
			failures = run.attempt(check, expected)
		}
		if failures == nil {
			return nil
		}
		return []string{fmt.Sprintf("%s %s not visible after %ss; last error: %s", check.label,
			strings.Join(slices.Sorted(slices.Values(expected)), ", "), pyG(run.wait), failures[0])}
	}
	var failures []string
	for attempt := int64(0); attempt <= run.retries; attempt++ {
		if failures = run.attempt(check, expected); failures == nil {
			return nil
		}
		if attempt < run.retries {
			run.pause(run.retryDelay)
		}
	}
	return failures
}

func (run *registryRun) attempt(check registryCheck, expected []string) []string {
	payload, status, err := run.fetch(check)
	switch {
	case status != 0:
		return []string{fmt.Sprintf("%s: registry returned HTTP %d for %s", check.label, status, check.url)}
	case err != nil:
		return []string{check.label + ": failed to read " + check.url + ": " + err.Error()}
	}
	found := check.versions(payload)
	if slices.ContainsFunc(found, func(version string) bool { return slices.Contains(expected, version) }) {
		return nil
	}
	sorted := func(values []string) []string { return slices.Compact(slices.Sorted(slices.Values(values))) }
	return []string{check.label + ": expected one of " + pyRepr(sorted(expected)) + ", found " + pyRepr(sorted(found))}
}

// absent passes when a registry lists none of the forbidden versions.
func (run *registryRun) absent(check registryCheck, forbidden []string) []string {
	payload, status, err := run.fetch(check)
	if status == http.StatusNotFound {
		return nil
	}
	found := []string{}
	if status == 0 && err == nil {
		found = check.versions(payload)
	}
	switch {
	case len(found) == 0:
		return []string{check.label + ": registry availability check failed"}
	case slices.ContainsFunc(found, func(version string) bool { return slices.Contains(forbidden, version) }):
		return []string{check.label + ": immutable registry version already exists"}
	}
	return nil
}

// fetch reads one registry page the way Python's urllib does: redirects
// followed, no content decoding, and any other status than 2xx reported.
func (run *registryRun) fetch(check registryCheck) (any, int, error) {
	if !(run.timeout >= 0 && run.timeout <= pyMaxSeconds) {
		panic(nativeStop{exitFailure, "invalid timeout: " + pyG(run.timeout)})
	}
	if run.timeout == 0 {
		return nil, 0, errors.New("timed out")
	}
	client := &http.Client{Transport: run.transport, Timeout: time.Duration(run.timeout * float64(time.Second))}
	request, _ := http.NewRequest(http.MethodGet, check.url, nil)
	request.Header.Set("User-Agent", "LogBrew public registry verifier")
	request.Header.Set("Accept-Encoding", "identity")
	response, err := client.Do(request)
	var body []byte
	if err == nil {
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode > 299 {
			return nil, response.StatusCode, nil
		}
		body, err = io.ReadAll(response.Body)
	}
	var requestError *url.Error
	if errors.As(err, &requestError) {
		err = requestError.Err
	}
	switch {
	case err != nil:
		return nil, 0, err
	case !utf8.Valid(body):
		return nil, 0, errUnicodeDecode
	case check.text:
		return string(body), 0, nil
	}
	payload, err := decodePlanJSON(body)
	return payload, 0, err
}

// pause sleeps, and stops on a length Python's time.sleep rejects.
func (run *registryRun) pause(seconds float64) {
	if !(seconds >= 0 && seconds <= pyMaxSeconds) {
		panic(nativeStop{exitFailure, "invalid sleep length: " + pyG(seconds)})
	}
	run.sleep(seconds)
}

func registryGoModule(version string) []string {
	if _, err := exec.LookPath("go"); err != nil {
		return []string{"go: command not found"}
	}
	directory, err := os.MkdirTemp("", "logbrew-go-registry-")
	if err != nil {
		panic(nativeStop{exitFailure, "cannot create a temporary directory"})
	}
	defer os.RemoveAll(directory)
	module := "github.com/LogBrewCo/sdk/go/logbrew@v" + strings.TrimPrefix(version, "v")
	for _, step := range [][]string{{"go mod init", "mod", "init", "logbrew.registry.verify"},
		{"go get " + module, "get", module}} {
		command := exec.Command("go", step[1:]...)
		command.Dir = directory
		if output, err := command.CombinedOutput(); err != nil {
			return []string{step[0] + " failed: " + pyStrip(string(output))}
		}
	}
	return nil
}

func (run *registryRun) summary() string {
	overrides := []string{}
	for _, family := range []struct{ label, name string }{{"npm", "npm"}, {"pypi", "pypi"},
		{"RubyGems", "rubygems"}, {"Packagist", "packagist"}, {"crates.io", "crates"}, {"nuget", "nuget"},
		{"maven", "maven"}} {
		versions := run.versions[family.name]
		if fixed := map[string][2]string{"rubygems": {"logbrew-sdk", run.rubygems}, "packagist": {"logbrew/sdk",
			run.packagist}, "crates": {"logbrew", run.crates}}[family.name]; fixed[0] != "" {
			versions = map[string]string{}
			if slices.Contains(run.targets, family.name) || slices.Contains(run.targets, "all") {
				versions[fixed[0]] = fixed[1]
			}
		}
		entries := []string{}
		for _, name := range slices.Sorted(maps.Keys(versions)) {
			entries = append(entries, name+"@"+versions[name])
		}
		if len(entries) > 0 {
			overrides = append(overrides, family.label+" overrides: "+strings.Join(entries, ", "))
		}
	}
	state := map[bool]string{false: "ok", true: "absent"}[run.switches["expect-absent"]]
	text := "public registry versions " + state + " for " + strings.Join(run.targets, ", ") + " at " + run.version
	if len(overrides) > 0 {
		text += "; " + strings.Join(overrides, "; ")
	}
	return text
}

func npmVersions(payload any) []string {
	versions := nonEmpty(field(payload, "dist-tags", "latest"))
	if releases, ok := field(payload, "versions").(map[string]any); ok {
		versions = append(versions, slices.Collect(maps.Keys(releases))...)
	}
	return versions
}

func npmProvenanceVersions(payload any) []string {
	attestations := field(payload, "dist", "attestations")
	version, versionOK := field(payload, "version").(string)
	address, addressOK := field(attestations, "url").(string)
	if field(attestations, "provenance", "predicateType") != "https://slsa.dev/provenance/v1" || !versionOK ||
		!addressOK || !strings.HasPrefix(address, "https://registry.npmjs.org/-/npm/v1/attestations/") ||
		!strings.HasSuffix(address, "@"+pyQuote(version, "")) {
		return nil
	}
	return []string{version}
}

func pypiVersions(payload any) []string {
	versions := nonEmpty(field(payload, "info", "version"))
	if releases, ok := field(payload, "releases").(map[string]any); ok {
		versions = append(versions, slices.Collect(maps.Keys(releases))...)
	}
	return versions
}

// nugetVersions iterates the versions value as Python does: a list's
// strings, an object's keys, or a string's characters.
func nugetVersions(payload any) []string {
	versions := []string{}
	switch value := field(payload, "versions").(type) {
	case []any:
		for _, item := range value {
			if text, ok := item.(string); ok {
				versions = append(versions, text)
			}
		}
	case map[string]any:
		versions = slices.Collect(maps.Keys(value))
	case string:
		for _, character := range value {
			versions = append(versions, string(character))
		}
	}
	return versions
}

func packagistVersions(payload any) []string {
	versions := []string{}
	entries, _ := field(payload, "packages", "logbrew/sdk").([]any)
	for _, entry := range entries {
		if version, ok := field(entry, "version").(string); ok {
			versions = append(versions, version)
		}
	}
	return versions
}

// cratesVersions reads the sparse index: one JSON release per line.
func cratesVersions(payload any) []string {
	versions := []string{}
	for _, line := range pySplitLines(payload.(string)) {
		entry, err := decodePlanJSON([]byte(line))
		if version, ok := field(entry, "vers").(string); err == nil && ok && !pyTruthy(field(entry, "yanked")) {
			versions = append(versions, version)
		}
	}
	return versions
}

func mavenVersions(payload any) []string {
	root, err := parseXML([]byte(payload.(string)))
	if err != nil {
		return nil
	}
	children := func(parents []*xmlElement, name string) []*xmlElement {
		found := []*xmlElement{}
		for _, parent := range parents {
			for _, child := range parent.children {
				if child.space == "" && child.name == name {
					found = append(found, child)
				}
			}
		}
		return found
	}
	text := func(element *xmlElement) []string {
		if element.value == nil {
			return nil
		}
		return nonEmpty(*element.value)
	}
	versions := []string{}
	versioning := children([]*xmlElement{root}, "versioning")
	for _, name := range []string{"latest", "release"} {
		if found := children(versioning, name); len(found) > 0 {
			versions = append(versions, text(found[0])...)
		}
	}
	for _, element := range children(children(versioning, "versions"), "version") {
		versions = append(versions, text(element)...)
	}
	return versions
}

func nonEmpty(value any) []string {
	if text, ok := value.(string); ok && text != "" {
		return []string{text}
	}
	return nil
}

// pyTruthy reports whether a decoded JSON value is true in Python.
func pyTruthy(value any) bool {
	switch value := value.(type) {
	case nil:
		return false
	case bool:
		return value
	case string:
		return value != ""
	case []any:
		return len(value) > 0
	case map[string]any:
		return len(value) > 0
	}
	number, _ := pyNumber(value)
	return number != 0
}

// pyQuote percent-encodes like urllib.parse.quote with the safe characters.
func pyQuote(text, safe string) string {
	var quoted strings.Builder
	for _, value := range []byte(text) {
		if 'a' <= value|0x20 && value|0x20 <= 'z' || '0' <= value && value <= '9' ||
			strings.IndexByte("_.-~"+safe, value) >= 0 {
			quoted.WriteByte(value)
		} else {
			fmt.Fprintf(&quoted, "%%%02X", value)
		}
	}
	return quoted.String()
}

// pyFloat parses text the way Python's float() does.
func pyFloat(text string) (float64, bool) {
	text = pyStrip(text)
	if !pyFloatPattern.MatchString(text) {
		return 0, false
	}
	value, _ := strconv.ParseFloat(strings.ReplaceAll(text, "_", ""), 64)
	return value, true
}

// pyG formats a number like Python's format(value, "g").
func pyG(value float64) string {
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return strings.ToLower(strings.TrimPrefix(strconv.FormatFloat(value, 'g', 6, 64), "+"))
	}
	return fmt.Sprintf("%.6g", value)
}

func cmpOrSlice(values, fallback []string) []string {
	if len(values) == 0 {
		return fallback
	}
	return values
}
