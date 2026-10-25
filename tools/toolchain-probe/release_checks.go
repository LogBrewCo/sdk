package main

import (
	"bytes"
	"cmp"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	releaseChecksMode  = "release-checks"
	releaseChecksUsage = "usage: release-checks npm-peers MANIFEST PACKAGE=VERSION... | maven-jar JAR VERSION | " +
		"npm-workspace|npm-plan|maven-pom|maven-deployment capture|maven-deployment wait|nuget-provenance|" +
		"publication-run|release-notes [flags]\n"
	mavenJARFailure = "Maven JAR metadata validation failed\n"
	mavenPOMPath    = "META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
)

var (
	plainSemVer    = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
	commitSubject  = regexp.MustCompile(`^([a-z]+)(?:\([^)]*\))?!?: (.+)$`)
	releaseSection = [][2]string{{"feat", "Added"}, {"fix", "Fixed"}, {"perf", "Faster"}}
	// Each command's options as its Python parser had them: required values
	// (repeated when also listed in repeated), "name=default" values,
	// switches, and the positional count.
	releaseCheckSpecs = map[string]checkSpec{
		"npm-workspace": {required: []string{"workspace-dir", "selected-dir"}, repeated: []string{"workspace-dir",
			"selected-dir"}, optional: []string{"registry=https://registry.npmjs.org"}},
		"npm-plan":                 {repeated: []string{"package"}, optional: []string{"registry=https://registry.npmjs.org"}},
		"maven-pom":                {required: []string{"group-id", "artifact-id", "version"}, positional: 1},
		"maven-deployment capture": {required: []string{"deployment-id-file"}},
		"maven-deployment wait": {required: []string{"deployment-id-file"}, switches: []string{"once"},
			optional: []string{"timeout-seconds=3600", "poll-interval-seconds=30", "request-timeout-seconds=20"}},
		"nuget-provenance": {required: []string{"bound-dir", "source-dir", "packages-dir", "assets", "core-version",
			"httpclient-version"}},
		"publication-run": {required: []string{"repository", "run-id", "family", "workflow-sha", "source-sha"}},
		"release-notes":   {required: []string{"since"}, optional: []string{"until=HEAD"}, positional: 1},
	}
)

// checkSpec lists one command's options.
type checkSpec struct {
	required, repeated, optional, switches []string
	positional                             int
}

// checkArgs holds one command's parsed options.
type checkArgs struct {
	values     map[string]string
	lists      map[string][]string
	switches   map[string]bool
	positional []string
}

// releaseTools are the network and clock a release check uses.
type releaseTools struct {
	transport http.RoundTripper
	input     io.Reader
	sleep     func(time.Duration)
	now       func() time.Time
}

// parseCheck parses options and positionals in any order, like argparse,
// and reports whether help was asked for.
func parseCheck(spec checkSpec, arguments []string) (checkArgs, bool, error) {
	flags := flag.NewFlagSet(releaseChecksMode, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	parsed := checkArgs{values: map[string]string{}, lists: map[string][]string{}, switches: map[string]bool{}}
	values, lists, switches := map[string]*string{}, map[string]*versionFlags{}, map[string]*bool{}
	for _, name := range spec.repeated {
		lists[name] = &versionFlags{}
		flags.Var(lists[name], name, "")
	}
	for _, entry := range append(slices.Clone(spec.required), spec.optional...) {
		if name, value, _ := strings.Cut(entry, "="); lists[name] == nil {
			values[name] = flags.String(name, value, "")
		}
	}
	for _, name := range spec.switches {
		switches[name] = flags.Bool(name, false, "")
	}
	var err error
	for rest := arguments; ; {
		err = flags.Parse(rest)
		if consumed := len(rest) - flags.NArg(); err != nil || flags.NArg() == 0 || consumed > 0 && rest[consumed-1] == "--" {
			parsed.positional = append(parsed.positional, flags.Args()...)
			break
		}
		parsed.positional, rest = append(parsed.positional, flags.Arg(0)), flags.Args()[1:]
	}
	set := map[string]bool{}
	flags.Visit(func(used *flag.Flag) { set[used.Name] = true })
	for _, name := range spec.required {
		err = cmp.Or(err, map[bool]error{false: errors.New("missing " + name)}[set[name]])
	}
	if err == nil && len(parsed.positional) != spec.positional {
		err = errors.New("wrong positional count")
	}
	for name, value := range values {
		parsed.values[name] = *value
	}
	for name, value := range lists {
		parsed.lists[name] = *value
	}
	for name, value := range switches {
		parsed.switches[name] = *value
	}
	return parsed, errors.Is(err, flag.ErrHelp), err
}

// checkRelease runs one release check that publishing, reconciliation, or a
// package smoke uses.
func checkRelease(arguments []string, tools releaseTools, output, diagnostic io.Writer) int {
	command := ""
	if len(arguments) > 0 {
		command, arguments = arguments[0], arguments[1:]
	}
	if command == "maven-deployment" && len(arguments) > 0 && releaseCheckSpecs[command+" "+arguments[0]].required != nil {
		command, arguments = command+" "+arguments[0], arguments[1:]
	}
	switch command {
	case "npm-peers":
		return checkNPMPeers(arguments, output, diagnostic)
	case "maven-jar":
		if len(arguments) != 2 || !validMavenJAR(arguments[0], arguments[1]) {
			return writeText(diagnostic, mavenJARFailure, exitFailure)
		}
		return exitOK
	}
	spec, found := releaseCheckSpecs[command]
	parsed, help, err := parseCheck(spec, arguments)
	runID, number := pyInt(parsed.values["run-id"], 10, false)
	if help || command == "-h" || command == "--help" {
		return writeText(output, releaseChecksUsage, exitOK)
	}
	if !found || err != nil || command == "publication-run" && (!number || publicationContracts[parsed.values["family"]].job == "") {
		return writeText(diagnostic, releaseChecksUsage, exitUsage)
	}
	switch command {
	case "npm-workspace":
		return checkNPMWorkspace(parsed, tools.transport, output, diagnostic)
	case "npm-plan":
		text, err := npmPlan(parsed.values["registry"], parsed.lists["package"], tools.transport)
		if err != nil {
			return writeText(diagnostic, "npm publication preflight failed: "+err.Error()+"\n", exitFailure)
		}
		return writeText(output, text, exitOK)
	case "maven-pom":
		return checkMavenPOM(parsed, output, diagnostic)
	case "nuget-provenance":
		if !nugetProvenance(parsed.values) {
			return writeText(diagnostic, "NuGet receipt provenance verification failed\n", exitFailure)
		}
		return exitOK
	case "publication-run":
		if !verifyPublicationRun(parsed.values, runID, os.Getenv("GITHUB_AUTHORIZATION"), tools.transport) {
			return writeText(diagnostic, "publication run verification failed\n", exitFailure)
		}
		return writeText(output, "publication run verification ok\n", exitOK)
	case "release-notes":
		text, err := releaseNotes(parsed.positional[0], parsed.values["since"], parsed.values["until"])
		if err != nil {
			return writeText(diagnostic, "release notes failed: git log failed\n", exitFailure)
		}
		return writeText(output, text, exitOK)
	}
	return mavenDeployment(command, parsed, tools, output, diagnostic)
}

// caretAllows reports whether a ^MAJOR.MINOR.PATCH range includes a plain
// version, comparing numbers of any length.
func caretAllows(caret, version string) bool {
	lower, found := strings.CutPrefix(caret, "^")
	low, high := plainSemVer.FindStringSubmatch(lower), plainSemVer.FindStringSubmatch(version)
	if !found || low == nil || high == nil {
		return false
	}
	compare := func(index int) int {
		return cmp.Or(cmp.Compare(len(high[index]), len(low[index])), strings.Compare(high[index], low[index]))
	}
	switch {
	case low[1] != "0":
		return compare(1) == 0 && cmp.Or(compare(2), compare(3)) >= 0
	case low[2] != "0":
		return high[1] == "0" && compare(2) == 0 && compare(3) >= 0
	}
	return high[1] == "0" && high[2] == "0" && compare(3) == 0
}

// checkNPMPeers checks that a package's peer ranges include the given
// package versions.
func checkNPMPeers(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) < 2 {
		return writeText(diagnostic, "usage: release-checks npm-peers MANIFEST PACKAGE=VERSION [...]\n", exitUsage)
	}
	names, versions := []string{}, map[string]string{}
	for _, requirement := range arguments[1:] {
		index := strings.LastIndex(requirement, "=")
		if index <= 0 || !plainSemVer.MatchString(requirement[index+1:]) {
			return writeText(diagnostic, "invalid package requirement: "+pyString(requirement)+"\n", exitUsage)
		}
		if _, found := versions[requirement[:index]]; !found {
			names = append(names, requirement[:index])
		}
		versions[requirement[:index]] = requirement[index+1:]
	}
	path := pyPurePath(arguments[0])
	data, err := os.ReadFile(arguments[0])
	var manifest any
	if err == nil {
		manifest, err = decodePlanJSON(data)
	}
	object, valid := manifest.(map[string]any)
	peers, found := object["peerDependencies"].(map[string]any)
	if _, present := object["peerDependencies"]; err != nil || !valid || present && !found {
		return writeText(diagnostic, path+": invalid npm manifest\n", exitFailure)
	}
	failures := []string{}
	for _, name := range names {
		if text, ok := peers[name].(string); !ok || !caretAllows(text, versions[name]) {
			failures = append(failures, fmt.Sprintf("%s: peer %s range %s does not include %s", path, name,
				pyRepr(peers[name]), versions[name]))
		}
	}
	if len(failures) > 0 {
		return writeText(diagnostic, strings.Join(failures, "\n")+"\n", exitFailure)
	}
	return writeText(output, "npm peer compatibility ok\n", exitOK)
}

// checkMavenPOM checks the coordinates and the project, license, developer,
// and source fields Maven Central shows.
func checkMavenPOM(parsed checkArgs, output, diagnostic io.Writer) int {
	data, err := os.ReadFile(parsed.positional[0])
	var root *xmlElement
	if err == nil {
		root, err = parseXML(data)
	}
	if err != nil {
		return writeText(diagnostic, "invalid Maven POM: "+err.Error()+"\n", exitFailure)
	}
	failures := []string{}
	for _, field := range [][2]string{{"groupId", "group-id"}, {"artifactId", "artifact-id"}, {"version", "version"}} {
		if actual, expected := mavenText(root, field[0]), parsed.values[field[1]]; actual != expected {
			failures = append(failures, fmt.Sprintf("- m:%s=%s, expected %s", field[0], pyString(actual), pyString(expected)))
		}
	}
	for _, field := range [][2]string{{"name", "project name"}, {"description", "project description"},
		{"url", "project url"}, {"licenses/license/name", "license name"}, {"licenses/license/url", "license url"},
		{"developers/developer/name", "developer name"}, {"scm/url", "scm url"}} {
		if mavenText(root, strings.Split(field[0], "/")...) == "" {
			failures = append(failures, "- "+field[1])
		}
	}
	if len(failures) > 0 {
		return writeText(diagnostic, "missing or invalid Maven Central POM metadata:\n"+strings.Join(failures, "\n")+"\n",
			exitFailure)
	}
	return writeText(output, "maven pom metadata checks passed\n", exitOK)
}

// mavenText returns the stripped text of the first element on a path of POM
// names, like ElementTree's find, or "" when there is none.
func mavenText(element *xmlElement, names ...string) string {
	found := pomFind(element, names)
	if found == nil || found.value == nil {
		return ""
	}
	return pyStrip(*found.value)
}

func pomFind(element *xmlElement, names []string) *xmlElement {
	if len(names) == 0 {
		return element
	}
	for _, child := range element.children {
		if child.space == mavenNamespace && child.name == names[0] {
			if found := pomFind(child, names[1:]); found != nil {
				return found
			}
		}
	}
	return nil
}

// validMavenJAR reports whether a release JAR embeds exactly one POM, at the
// SDK's path, with the SDK's coordinates and the version.
func validMavenJAR(path, version string) bool {
	info, err := os.Lstat(path)
	if !mavenPlanVersion.MatchString(version) || err != nil || !info.Mode().IsRegular() {
		return false
	}
	data, _ := os.ReadFile(path)
	entries, err := openZip(data)
	poms := slices.DeleteFunc(slices.Clone(entries), func(entry zipEntry) bool {
		return !strings.HasPrefix(entry.name, "META-INF/maven/") || !strings.HasSuffix(entry.name, "/pom.xml")
	})
	if err != nil || len(entries) > 20_000 || len(poms) != 1 || poms[0].name != mavenPOMPath || poms[0].size == 0 ||
		poms[0].size > 256<<10 {
		return false
	}
	document, err := readZipFile(poms[0])
	document = bytes.TrimPrefix(document, []byte("\xef\xbb\xbf"))
	var project *xmlElement
	if err == nil && utf8.Valid(document) && !bytes.Contains(document, []byte("<!DOCTYPE")) &&
		!bytes.Contains(document, []byte("<!ENTITY")) {
		project, err = parseXML(document)
	}
	if project == nil || err != nil || project.space != mavenNamespace || project.name != "project" {
		return false
	}
	for _, field := range [][2]string{{"groupId", "co.logbrew"}, {"artifactId", "logbrew-sdk"}, {"version", version}} {
		matches := slices.DeleteFunc(slices.Clone(project.children), func(child *xmlElement) bool { return child.name != field[0] })
		if len(matches) != 1 || matches[0].space != mavenNamespace || len(matches[0].children) > 0 ||
			mavenText(matches[0]) != field[1] {
			return false
		}
	}
	return true
}

// nugetProvenance reports whether the installed LogBrew and LogBrew.HttpClient
// packages hold the bound bytes and were installed from the source folder.
func nugetProvenance(values map[string]string) bool {
	bound, boundError := pyResolve(values["bound-dir"], true)
	source, sourceError := pyResolve(values["source-dir"], true)
	assets, assetsError := readNuGetJSON(values["assets"])
	libraries, found := assets["libraries"].(map[string]any)
	if boundError != nil || sourceError != nil || bound == source || assetsError != nil || !found {
		return false
	}
	for _, release := range [][3]string{{"LogBrew", "core-version", "0.nupkg"},
		{"LogBrew.HttpClient", "httpclient-version", "1.nupkg"}} {
		version, name := values[release[1]], strings.ToLower(release[0])
		data, err := readRegular(pyJoin(values["bound-dir"], release[2]))
		library, _ := libraries[release[0]+"/"+version].(map[string]any)
		directory := pyJoin(values["packages-dir"], name, version)
		recorded, hashError := os.ReadFile(pyJoin(directory, name+"."+version+".nupkg.sha512"))
		metadata, metadataError := readNuGetJSON(pyJoin(directory, ".nupkg.metadata"))
		origin, _ := metadata["source"].(string)
		resolved, originError := pyResolve(origin, true)
		digest := sha512.Sum512(data)
		if err != nil || !pyEqual(library["type"], "package") ||
			hashError != nil || metadataError != nil || !utf8.Valid(recorded) || !strings.HasPrefix(origin, "/") ||
			originError != nil || resolved != source ||
			canonicalSHA512(pyStrip(string(recorded))) != base64.StdEncoding.EncodeToString(digest[:]) ||
			canonicalSHA512(metadata["contentHash"]) == "" || canonicalSHA512(metadata["contentHash"]) !=
			canonicalSHA512(library["sha512"]) {
			return false
		}
	}
	return true
}

// canonicalSHA512 returns a canonical base64 SHA-512 digest, or "".
func canonicalSHA512(value any) string {
	text, _ := value.(string)
	decoded, err := base64.StdEncoding.Strict().DecodeString(text)
	if err != nil || len(decoded) != sha512.Size || base64.StdEncoding.EncodeToString(decoded) != text {
		return ""
	}
	return text
}

// readRegular reads a regular file that is not a symbolic link.
func readRegular(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err == nil && !info.Mode().IsRegular() {
		err = fs.ErrInvalid
	}
	if err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

func readNuGetJSON(path string) (map[string]any, error) {
	value, err := readPlanJSON(path)
	object, found := value.(map[string]any)
	if err == nil && !found {
		err = errJSONDecode
	}
	return object, err
}

// pyJoin joins paths like pathlib, where an absolute part starts over.
func pyJoin(parts ...string) string {
	joined := ""
	for _, part := range parts {
		if strings.HasPrefix(part, "/") || joined == "" {
			joined = part
		} else if part != "" {
			joined = strings.TrimSuffix(joined, "/") + "/" + part
		}
	}
	return joined
}

// releaseNotes groups the feat, fix, and perf commit subjects that touched a
// path into release notes.
func releaseNotes(path, since, until string) (string, error) {
	data, err := exec.Command("git", "log", "--no-merges", "--reverse", "--format=%s", since+".."+until, "--", path).Output()
	if err == nil && !utf8.Valid(data) {
		err = errUnicodeDecode
	}
	grouped := map[string][]string{}
	for _, subject := range pySplitLines(string(data)) {
		if match := commitSubject.FindStringSubmatch(subject); match != nil {
			grouped[match[1]] = append(grouped[match[1]], "- "+match[2])
		}
	}
	lines := []string{}
	for _, section := range releaseSection {
		if len(grouped[section[0]]) > 0 {
			lines = append(append(append(lines, "### "+section[1]), grouped[section[0]]...), "")
		}
	}
	if len(lines) == 0 {
		return "Maintenance release with no behavior changes.\n", err
	}
	return strings.Join(lines, "\n"), err
}
