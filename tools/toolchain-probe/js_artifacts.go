package main

import (
	"crypto/sha1" //nolint:gosec // G505: UUID version 5 is defined over SHA-1.
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	jsArtifactVersion = "0.1.0"
	jsVLQAlphabet     = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	jsSymbolicator    = "logbrew-js-release-artifact-symbolication-verifier"
)

var (
	// Python's case-insensitive matching also lets İ and ı match i.
	jsSourceMappingPattern = regexp.MustCompile(`(?i)(?://#|/\*#)[` + pySpaceClass +
		`]*sourceMapp[i\x{130}\x{131}]ngURL=([^` + pySpaceClass + `*]+)`)
	jsDebugIDPattern = regexp.MustCompile(`(?i)(?://#|/\*#)[` + pySpaceClass +
		`]*debug[i\x{130}\x{131}]d=([A-Za-z0-9._:\x{130}\x{131}-]+)`)
	jsMappingCommentPattern = regexp.MustCompile(`(?://#|/\*#)[` + pySpaceClass + `]*sourceMappingURL=[^\r\n]*`)
	jsWindowsPathPattern    = regexp.MustCompile(`^[A-Za-z]:[\\/]`)
	jsDebugIDKeys           = []string{"debug_id", "debugId", "debugID", "x_debug_id"}
	jsDebugIDNamespace      = []byte{0x16, 0xf4, 0xa8, 0x37, 0x7e, 0x0b, 0x4d, 0x7c, 0x97, 0xd9, 0x8a, 0x7a, 0xf1, 0xfd, 0x27, 0x68}
	// Each command's required flags.
	jsArtifactFlags = map[string][]string{
		"js-prepare":     {"build-dir"},
		"js-manifest":    {"build-dir", "release", "environment", "service", "minified-path-prefix"},
		"js-symbolicate": {"build-dir", "manifest", "stack-frame"},
		"js-fake-intake": {"port-file", "state-file", "expected-bearer", "source-sentinel", "query-placeholder", "hash-fragment"},
	}
)

// jsArtifact holds what one minified file and its source map declare.
type jsArtifact struct {
	path, relative, source, debugID, mappingURL, mapPath, mapRelative string
	payload                                                           map[string]any
	errors, warnings                                                  []string
}

// checkJSArtifacts prepares debug IDs, writes the dry-run manifest, resolves
// a stack frame for JavaScript release artifacts, or runs the loopback fake
// intake for upload smoke checks.
func checkJSArtifacts(command string, arguments []string, output, diagnostic io.Writer) (code int) {
	usage := "usage: release-artifacts " + command + " --" + strings.Join(jsArtifactFlags[command], " VALUE --") +
		" VALUE [options]\n"
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	values, set := map[string]*string{}, map[string]bool{}
	for _, name := range jsArtifactFlags[command] {
		values[name] = flags.String(name, "", "")
	}
	var prefixes versionFlags
	options := map[string]*bool{}
	switch command {
	case "js-prepare":
		flags.Var(&prefixes, "strip-source-prefix", "")
		options["write"], options["strip"] = flags.Bool("write", false, ""), flags.Bool("strip-sources-content", false, "")
	case "js-manifest":
		values["repository-url"], values["commit-sha"] = flags.String("repository-url", "", ""), flags.String("commit-sha", "", "")
		options["allow"] = flags.Bool("allow-sources-content", false, "")
	}
	err := flags.Parse(arguments)
	flags.Visit(func(used *flag.Flag) { set[used.Name] = true })
	for _, name := range jsArtifactFlags[command] {
		err = requireFlag(err, set[name])
	}
	if errors.Is(err, flag.ErrHelp) {
		return writeText(output, usage, exitOK)
	}
	if err != nil || flags.NArg() > 0 {
		return writeText(diagnostic, usage, exitUsage)
	}
	defer func() {
		if value := recover(); value != nil {
			stop := value.(nativeStop)
			code = writeText(diagnostic, stop.message+"\n", stop.code)
		}
	}()
	switch command {
	case "js-prepare":
		return jsPrepare(*values["build-dir"], prefixes, *options["write"], *options["strip"], output)
	case "js-manifest":
		return jsManifest(values, *options["allow"], output)
	case "js-symbolicate":
		return jsSymbolicate(values, output)
	}
	return jsFakeIntake(values)
}

func requireFlag(err error, present bool) error {
	if err == nil && !present {
		return errors.New("missing flag")
	}
	return err
}

// jsStop ends a command the way the scripts ended on an exception: a
// ValueError printed with prefix and code 2, anything else with code 1.
func jsStop(prefix string, err error) nativeStop {
	var osError pyOSError
	if errors.As(err, &osError) {
		return nativeStop{exitFailure, err.Error()}
	}
	return nativeStop{exitUsage, prefix + err.Error()}
}

// jsBuildDirectory resolves the build directory or stops.
func jsBuildDirectory(path, prefix string) string {
	directory, _ := pyRealpath(pyPath(path))
	if !pyIsDir(directory) {
		panic(nativeStop{exitUsage, prefix + "build directory does not exist: " + directory})
	}
	return directory
}

// jsFiles lists minified JavaScript files in pathlib's rglob order.
func jsFiles(directory string) []string {
	return slices.DeleteFunc(nativeWalk(directory), func(path string) bool {
		name := filepath.Base(path)
		return !nativeRegular(path) || strings.HasSuffix(name, ".map") || !slices.ContainsFunc(
			[]string{".js", ".mjs", ".bundle", ".jsbundle"}, func(suffix string) bool { return strings.HasSuffix(name, suffix) })
	})
}

func lastMatch(pattern *regexp.Regexp, text string) string {
	matches := pattern.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return ""
	}
	return pyStrip(matches[len(matches)-1][1])
}

func fileReference(value string) string { return before(before(value, "?"), "#") }

// readJSArtifact reads a minified file and the source map it declares.
func readJSArtifact(path, directory string) (*jsArtifact, error) {
	artifact := &jsArtifact{path: path, relative: pyRelative(path, directory), errors: []string{}, warnings: []string{}}
	if nativeSize(path) == 0 {
		artifact.errors = append(artifact.errors, "minified source file is empty")
	}
	source, err := pyReadText(path)
	if err != nil {
		return nil, err
	}
	artifact.source, artifact.debugID = source, lastMatch(jsDebugIDPattern, source)
	artifact.mappingURL = lastMatch(jsSourceMappingPattern, source)
	if err = artifact.resolveMap(directory); err != nil {
		return nil, err
	}
	switch {
	case artifact.mapPath == "":
		artifact.errors = append(artifact.errors, "source map file is missing")
	case !pyExists(artifact.mapPath):
		artifact.errors = append(artifact.errors, "source map file is missing: "+pyRelative(artifact.mapPath, directory))
	case nativeSize(artifact.mapPath) == 0:
		artifact.errors = append(artifact.errors, "source map file is empty: "+pyRelative(artifact.mapPath, directory))
	default:
		artifact.mapRelative = pyRelative(artifact.mapPath, directory)
		payload, problem, err := readJSONObject(artifact.mapPath, "source map")
		if err != nil {
			return nil, err
		}
		artifact.payload = payload
		if problem != "" {
			artifact.errors = append(artifact.errors, problem)
		}
	}
	return artifact, nil
}

func (artifact *jsArtifact) resolveMap(directory string) error {
	if artifact.mappingURL == "" {
		artifact.warnings = append(artifact.warnings, "sourceMappingURL comment missing; checked sibling .map fallback")
		if pyExists(artifact.path + ".map") {
			artifact.mapPath = artifact.path + ".map"
		}
		return nil
	}
	reference := fileReference(artifact.mappingURL)
	if strings.HasPrefix(reference, "data:") {
		artifact.errors = append(artifact.errors, "inline source maps are not accepted for release artifact manifests")
		return nil
	}
	parts, err := pyURLSplit(reference)
	if err != nil {
		return err
	}
	if parts.scheme != "" && parts.netloc != "" {
		artifact.errors = append(artifact.errors, "external sourceMappingURL cannot be validated from the local build directory")
		return nil
	}
	candidate := filepath.Dir(artifact.path) + "/" + reference
	if strings.HasPrefix(reference, "/") {
		candidate = directory + "/" + strings.TrimLeft(reference, "/")
	}
	if resolved, inside := pySafeResolve(candidate, directory); inside {
		artifact.mapPath = resolved
	} else {
		artifact.errors = append(artifact.errors, "sourceMappingURL resolves outside the build directory")
	}
	return nil
}

// readJSONObject reads a JSON object from a UTF-8 file. A document that is not
// JSON or not an object gives a problem that names it as label.
func readJSONObject(path, label string) (map[string]any, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", pyOSErrorText(err, path)
	}
	if !utf8.Valid(data) {
		return nil, "", pyValueError(label + " is not UTF-8: " + path)
	}
	value, err := decodePlanJSON(data)
	if err != nil || !validCheckEscapes(data) {
		return nil, label + " is not valid JSON", nil
	}
	object, isObject := value.(map[string]any)
	if !isObject {
		return nil, label + " must be a JSON object", nil
	}
	return object, "", nil
}

func sourceMapDebugID(payload map[string]any) string {
	for _, key := range jsDebugIDKeys {
		if value, isString := payload[key].(string); isString && pyStrip(value) != "" {
			return pyStrip(value)
		}
	}
	return ""
}

func jsValidation(errors, warnings []string) map[string]any {
	return map[string]any{"status": map[bool]string{true: "blocked", false: "ready"}[len(errors) > 0], "errors": errors,
		"warnings": warnings}
}

// jsCollect checks every minified file of a build directory.
func jsCollect(directory string, entry func(*jsArtifact) (map[string]any, error), stop string,
) ([]any, []*jsArtifact, []string, []string) {
	entries, artifacts, errors, warnings := []any{}, []*jsArtifact{}, []string{}, []string{}
	for _, path := range jsFiles(directory) {
		artifact, err := readJSArtifact(path, directory)
		var result map[string]any
		if err == nil {
			result, err = entry(artifact)
		}
		if err != nil {
			panic(jsStop(stop, err))
		}
		for _, message := range artifact.errors {
			errors = append(errors, artifact.relative+": "+message)
		}
		for _, message := range artifact.warnings {
			warnings = append(warnings, artifact.relative+": "+message)
		}
		entries, artifacts = append(entries, result), append(artifacts, artifact)
	}
	if len(entries) == 0 {
		errors = append(errors, "no JavaScript release artifact files found in build directory")
	}
	return entries, artifacts, errors, warnings
}

func jsPrint(output io.Writer, document map[string]any, code int) int {
	text, _ := pyJSONText(document, "  ")
	return writeText(output, text, code)
}

// pyCompactJSON encodes like Python's json.dumps with sort_keys, compact
// separators, and ensure_ascii=False.
func pyCompactJSON(value any) (string, error) {
	text, err := pyJSONEncode(value, "")
	// encoding/json escapes U+2028 and U+2029, which Python keeps as is.
	text = strings.NewReplacer(`\\`, `\\`, `\u2028`, "\u2028", `\u2029`, "\u2029").Replace(text)
	return strings.TrimSuffix(text, "\n"), err
}

func jsPrepare(buildDir string, rawPrefixes []string, write, strip bool, output io.Writer) int {
	const stop = "debug-id preparation failed: "
	if pyStrip(pyPath(buildDir)) == "" {
		panic(nativeStop{exitUsage, stop + "build directory is required"})
	}
	directory := jsBuildDirectory(buildDir, stop)
	prefixes := []string{}
	for _, prefix := range rawPrefixes {
		resolved, _ := pyRealpath(pyPath(prefix))
		for _, candidate := range []string{pyPurePath(prefix), resolved} {
			if value := strings.TrimRight(candidate, "/"); value != "" && !slices.Contains(prefixes, value) {
				prefixes = append(prefixes, value)
			}
		}
	}
	entries, artifacts, errors, warnings := jsCollect(directory, func(artifact *jsArtifact) (map[string]any, error) {
		return artifact.plan(strip, prefixes)
	}, stop)
	ready := len(errors) == 0
	for index, artifact := range artifacts {
		if !write || !ready {
			break
		}
		if err := artifact.apply(directory, entries[index].(map[string]any)["debugId"].(string), strip, prefixes); err != nil {
			panic(jsStop(stop, err))
		}
	}
	return jsPrint(output, map[string]any{"manifestVersion": 1, "stripSourcesContent": strip,
		"tool":                map[string]any{"name": "logbrew-js-release-artifact-debug-id-prep", "version": jsArtifactVersion},
		"stripSourcePrefixes": prefixes, "writeApplied": write && ready, "artifacts": entries,
		"validation": jsValidation(errors, warnings)}, map[bool]int{true: exitOK, false: exitFailure}[ready])
}

func (artifact *jsArtifact) plan(strip bool, prefixes []string) (map[string]any, error) {
	mapDebugID := sourceMapDebugID(artifact.payload)
	if artifact.debugID != "" && mapDebugID != "" && artifact.debugID != mapDebugID {
		artifact.errors = append(artifact.errors, "minified source debugId does not match source map debugId")
	}
	debugID, changes := cmpOr(artifact.debugID, mapDebugID), []string{}
	if len(artifact.errors) == 0 && artifact.payload != nil {
		if debugID == "" {
			canonical, _ := privacyUpdates(artifact.payload, "", strip, prefixes)
			for _, key := range jsDebugIDKeys {
				delete(canonical, key)
			}
			text, err := pyCompactJSON(canonical)
			if err != nil {
				return nil, err
			}
			digest := sha256.Sum256([]byte(artifact.relative + "\x00" + jsDebugIDPattern.ReplaceAllLiteralString(
				artifact.source, "") + "\x00" + text))
			name := sha1.Sum(append(slices.Clone(jsDebugIDNamespace), hex.EncodeToString(digest[:])...)) //nolint:gosec
			name[6], name[8] = name[6]&0x0f|0x50, name[8]&0x3f|0x80
			debugID = fmt.Sprintf("%x-%x-%x-%x-%x", name[:4], name[4:6], name[6:8], name[8:10], name[10:16])
		}
		if artifact.debugID == "" {
			changes = append(changes, "minifiedSource.debugId")
		}
		if mapDebugID == "" {
			changes = append(changes, "sourceMap.debug_id")
		}
		if _, found := artifact.payload["sourcesContent"]; strip && found {
			changes = append(changes, "sourceMap.sourcesContent")
		}
		if _, changed := sourcesWithoutPrefixes(artifact.payload, prefixes); changed {
			changes = append(changes, "sourceMap.sources")
		}
	}
	entry := map[string]any{"path": artifact.relative, "changes": changes,
		"validation": jsValidation(artifact.errors, artifact.warnings)}
	if artifact.mapRelative != "" {
		entry["sourceMapPath"] = artifact.mapRelative
	}
	if debugID != "" {
		entry["debugId"] = debugID
	}
	return entry, nil
}

// apply writes the debug ID into the minified file and the source map.
func (artifact *jsArtifact) apply(directory, debugID string, strip bool, prefixes []string) error {
	source, err := pyReadText(artifact.path)
	if err == nil && lastMatch(jsDebugIDPattern, source) == "" {
		line, separator := "//# debugId="+debugID+"\n", map[bool]string{false: "\n"}[strings.HasSuffix(source, "\n")]
		updated := source + separator + line
		if matches := jsMappingCommentPattern.FindAllStringIndex(source, -1); len(matches) > 0 {
			start := matches[len(matches)-1][0]
			separator = map[bool]string{false: "\n"}[strings.HasSuffix(source[:start], "\n") ||
				strings.HasSuffix(source[:start], "\r")]
			updated = source[:start] + separator + line + source[start:]
		}
		err = pyWriteText(artifact.path, updated)
	}
	mapPath := directory + "/" + artifact.mapRelative
	var payload map[string]any
	problem := ""
	if err == nil {
		payload, problem, err = readJSONObject(mapPath, "source map")
	}
	if err == nil && problem != "" {
		err = pyValueError(artifact.relative + ": source map became unreadable before write")
	}
	if err != nil {
		return err
	}
	if updated, changed := privacyUpdates(payload, debugID, strip, prefixes); changed {
		text, _ := pyJSONText(updated, "  ")
		err = pyWriteText(mapPath, text)
	}
	return err
}

// privacyUpdates returns the source map with a debug ID (when debugID is set
// and the map has none), without sourcesContent when strip is set, and with
// source prefixes removed, and whether anything changed.
func privacyUpdates(payload map[string]any, debugID string, strip bool, prefixes []string) (map[string]any, bool) {
	sources, changedSources := sourcesWithoutPrefixes(payload, prefixes)
	_, hasContent := payload["sourcesContent"]
	if (debugID == "" || sourceMapDebugID(payload) != "") && (!strip || !hasContent) && !changedSources {
		return maps.Clone(payload), false
	}
	updated := maps.Clone(payload)
	if debugID != "" && sourceMapDebugID(payload) == "" {
		updated["debug_id"] = debugID
	}
	if strip {
		delete(updated, "sourcesContent")
	}
	if changedSources {
		updated["sources"] = sources
	}
	return updated, true
}

func sourcesWithoutPrefixes(payload map[string]any, prefixes []string) ([]any, bool) {
	sources, isList := payload["sources"].([]any)
	if len(prefixes) == 0 || !isList {
		return nil, false
	}
	updated, changed := slices.Clone(sources), false
	for index, source := range sources {
		text, isString := source.(string)
		if !isString {
			continue
		}
		normalized := strings.ReplaceAll(text, `\`, "/")
		for _, prefix := range prefixes {
			if normalized == prefix {
				updated[index] = map[bool]string{false: pathBase(prefix)}[prefix == "."]
				break
			}
			if rest, found := strings.CutPrefix(normalized, prefix+"/"); found {
				updated[index] = rest
				break
			}
		}
		changed = changed || updated[index] != source
	}
	return updated, changed
}

func jsManifest(values map[string]*string, allow bool, output io.Writer) int {
	const stop = "manifest validation failed: "
	manifest := map[string]any{"manifestVersion": 1, "artifactType": "javascript_source_map_manifest",
		"uploader": map[string]any{"name": "logbrew-js-release-artifact-manifest", "version": jsArtifactVersion}}
	for _, name := range []string{"release", "environment", "service", "minified-path-prefix"} {
		if manifest[name] = pyStrip(*values[name]); manifest[name] == "" {
			panic(nativeStop{exitUsage, stop + strings.ReplaceAll(name, "-", " ") + " is required"})
		}
	}
	prefix, err := normalizeURLOrPath(manifest["minified-path-prefix"].(string))
	if err != nil {
		panic(jsStop(stop, err))
	}
	delete(manifest, "minified-path-prefix")
	manifest["minifiedPathPrefix"] = prefix
	directory := jsBuildDirectory(*values["build-dir"], stop)
	entries, _, errors, warnings := jsCollect(directory, func(artifact *jsArtifact) (map[string]any, error) {
		return artifact.manifestEntry(prefix, allow)
	}, stop)
	git := map[string]any{}
	for name, key := range map[string]string{"repository-url": "repositoryUrl", "commit-sha": "commitSha"} {
		if *values[name] != "" {
			git[key] = pyStrip(*values[name])
		}
	}
	if len(git) > 0 {
		manifest["git"] = git
	}
	manifest["artifacts"], manifest["validation"] = entries, jsValidation(errors, warnings)
	return jsPrint(output, manifest, map[bool]int{true: exitOK, false: exitFailure}[len(errors) == 0])
}

func (artifact *jsArtifact) manifestEntry(prefix string, allow bool) (map[string]any, error) {
	var sourceMap map[string]any
	mapDebugID := ""
	if payload := artifact.payload; payload != nil {
		_, hasContent := payload["sourcesContent"]
		sources, isList := payload["sources"].([]any)
		if payload["version"] == nil {
			artifact.errors = append(artifact.errors, "source map version is required")
		}
		if len(sources) == 0 {
			artifact.errors = append(artifact.errors, "source map sources must be a non-empty array")
		}
		if mappings, isString := payload["mappings"].(string); !isString || mappings == "" {
			artifact.errors = append(artifact.errors, "source map mappings must be a non-empty string")
		}
		switch {
		case hasContent && allow:
			artifact.warnings = append(artifact.warnings, "source map contains sourcesContent; ensure app policy permits source upload")
		case hasContent:
			artifact.errors = append(artifact.errors,
				"source map contains sourcesContent; rerun with --allow-sources-content only if policy permits it")
		}
		mapDebugID = sourceMapDebugID(payload)
		sourceMap = map[string]any{"path": artifact.mapRelative, "artifactSha256": nativeSHA256(artifact.mapPath),
			"byteSize": nativeSize(artifact.mapPath), "sourceCount": map[bool]int{true: len(sources)}[isList],
			"hasSourcesContent": hasContent}
		if mapDebugID != "" {
			sourceMap["debugId"] = mapDebugID
		}
	}
	if artifact.debugID != "" && mapDebugID != "" && artifact.debugID != mapDebugID {
		artifact.errors = append(artifact.errors, "minified source debugId does not match source map debugId")
	}
	if artifact.debugID == "" && mapDebugID == "" {
		artifact.warnings = append(artifact.warnings,
			"no debugId found; backend matching must rely on release/environment/service and minified path")
	}
	minified := map[string]any{"path": artifact.relative, "minifiedUrl": joinURLOrPath(prefix, artifact.relative), "artifactSha256": nativeSHA256(artifact.path),
		"byteSize": nativeSize(artifact.path)}
	entry := map[string]any{"artifactType": "javascript_source_map", "minifiedSource": minified, "sourceMap": sourceMap,
		"validation": jsValidation(artifact.errors, artifact.warnings)}
	if sourceMap == nil {
		entry["sourceMap"] = nil
	}
	if artifact.debugID != "" {
		minified["debugId"] = artifact.debugID
	}
	if artifact.mappingURL != "" {
		minified["sourceMappingUrl"] = artifact.mappingURL
	}
	if debugID := cmpOr(artifact.debugID, mapDebugID); debugID != "" {
		entry["debugId"] = debugID
	}
	return entry, nil
}

func normalizeURLOrPath(value string) (string, error) {
	value = pyStrip(value)
	parts, err := pyURLSplit(value)
	if err != nil || !pyHasNetloc(parts, value) {
		return strings.TrimRight(pyStrip(fileReference(value)), "/"), err
	}
	path := strings.TrimRight(pyNormpath(cmpOr(parts.path, "/")), "/")
	if parts.netloc == "" {
		path = cmpOr(path, "/")
	}
	return parts.scheme + "://" + parts.netloc + path, nil
}

// joinURLOrPath joins a path to a prefix that normalizeURLOrPath accepted.
func joinURLOrPath(prefix, relative string) string {
	prefix, _ = normalizeURLOrPath(prefix)
	relative = strings.ReplaceAll(strings.Trim(relative, "/"), `\`, "/")
	parts, _ := pyURLSplit(prefix)
	switch {
	case pyHasNetloc(parts, prefix):
		joined := strings.TrimRight(parts.path, "/")
		switch {
		case strings.HasPrefix(relative, "/") || joined == "":
			joined = relative
		default:
			joined += "/" + relative
		}
		if !strings.HasPrefix(joined, "/") {
			joined = "/" + joined
		}
		return parts.scheme + "://" + parts.netloc + joined
	case prefix == "":
		return relative
	}
	return strings.TrimRight(prefix, "/") + "/" + relative
}

func jsSymbolicate(values map[string]*string, output io.Writer) int {
	report, err := symbolicate(values)
	if err != nil {
		return jsPrint(output, map[string]any{"status": "validation_failed",
			"validation": map[string]any{"errors": []string{err.Error()}},
			"verifier":   map[string]any{"name": jsSymbolicator, "version": jsArtifactVersion}}, exitFailure)
	}
	return jsPrint(output, report, exitOK)
}

// readManifest reads a manifest or source map like read_manifest.
func readManifest(path string) (map[string]any, error) {
	object, problem, err := readJSONObject(path, "manifest")
	if problem != "" {
		err = pyValueError(problem)
	}
	return object, err
}

func symbolicate(values map[string]*string) (map[string]any, error) {
	manifest, err := readManifest(pyPath(*values["manifest"]))
	if err != nil {
		return nil, err
	}
	directory, _ := pyRealpath(pyPath(*values["build-dir"]))
	if !pyIsDir(directory) {
		return nil, pyValueError("build directory does not exist: " + directory)
	}
	frame, err := parseStackFrame(*values["stack-frame"])
	if err != nil {
		return nil, err
	}
	artifact, err := matchingArtifact(manifest, frame["filename"].(string), directory)
	if err != nil {
		return nil, err
	}
	payload, err := loadSourceMap(artifact, directory)
	if err != nil {
		return nil, err
	}
	original, err := originalPosition(payload, frame["line"].(int64), frame["column"].(int64))
	if err != nil {
		return nil, err
	}
	minified, sourceMap := artifact["minifiedSource"].(map[string]any), artifact["sourceMap"].(map[string]any)
	generated := map[string]any{"path": minified["path"], "minifiedUrl": minified["minifiedUrl"],
		"line": frame["lineText"], "column": frame["columnText"]}
	if frame["function"] != "" {
		generated["function"] = frame["function"]
	}
	return map[string]any{"status": "resolved", "verifier": map[string]any{"name": jsSymbolicator, "version": jsArtifactVersion},
		"release": manifest["release"], "environment": manifest["environment"], "service": manifest["service"],
		"debugId": artifact["debugId"], "generated": generated, "original": original,
		"sourceMap": map[string]any{"path": sourceMap["path"], "hasSourcesContent": false}}, nil
}

func parseStackFrame(text string) (map[string]any, error) {
	line := pyStrip(text)
	if rest, found := strings.CutPrefix(line, "at "); found {
		line = pyStrip(rest)
	}
	function, location := "", line
	if index := strings.LastIndex(line, " ("); index >= 0 && strings.HasSuffix(line, ")") {
		function, location = line[:index], line[index+2:len(line)-1]
	}
	column := strings.LastIndex(location, ":")
	lineStart := strings.LastIndex(location[:max(column, 0)], ":")
	if lineStart < 0 {
		return nil, pyValueError("stack frame must end with :line:column")
	}
	frame := map[string]any{"function": function, "filename": location[:lineStart]}
	for _, field := range [][3]any{{"line", lineStart + 1, column}, {"column", column + 1, len(location)}} {
		digits := location[field[1].(int):field[2].(int)]
		value, valid := pyInt(digits, 10, false)
		if !valid {
			return nil, pyValueError("stack frame line and column must be integers")
		}
		frame[field[0].(string)], frame[field[0].(string)+"Text"] = value, pyIntText(digits)
	}
	if frame["line"].(int64) < 1 || frame["column"].(int64) < 1 {
		return nil, pyValueError("stack frame line and column must be one-based positive integers")
	}
	return frame, nil
}

// pyIntText prints the value of text that pyInt accepted, without bounds.
func pyIntText(text string) json.Number {
	digits := strings.Builder{}
	for _, character := range text {
		if value, valid := pyInt(string(character), 10, false); valid {
			digits.WriteByte(byte('0' + value))
		} else if character == '-' {
			digits.WriteByte('-')
		}
	}
	negative, number := strings.HasPrefix(digits.String(), "-"), strings.TrimLeft(digits.String(), "-0")
	return json.Number(map[bool]string{true: "-"}[negative && number != ""] + cmpOr(number, "0"))
}

func matchingArtifact(manifest map[string]any, filename, directory string) (map[string]any, error) {
	ready := func(value any) bool {
		validation, isObject := value.(map[string]any)
		return isObject && validation["status"] == "ready"
	}
	artifacts, isList := manifest["artifacts"].([]any)
	switch {
	case manifest["artifactType"] != "javascript_source_map_manifest":
		return nil, pyValueError("only javascript_source_map_manifest symbolication proof is supported")
	case !ready(manifest["validation"]):
		return nil, pyValueError("manifest validation status must be ready")
	case !isList || len(artifacts) == 0:
		return nil, pyValueError("manifest must contain at least one JavaScript source-map artifact")
	}
	for _, value := range artifacts {
		artifact, isObject := value.(map[string]any)
		if !isObject {
			return nil, pyValueError("artifact entries must be JSON objects")
		}
		if !ready(artifact["validation"]) {
			return nil, pyValueError("all artifact validation statuses must be ready")
		}
	}
	normalize := func(value string) string {
		return strings.TrimPrefix(fileReference(pyStrip(value)), "file://")
	}
	frame := normalize(filename)
	for _, value := range artifacts {
		artifact := value.(map[string]any)
		minified, isObject := artifact["minifiedSource"].(map[string]any)
		if !isObject {
			continue
		}
		path, url := "", ""
		if value, found := minified["path"]; found {
			path = pyStr(value)
		}
		if value, found := minified["minifiedUrl"]; found {
			url = pyStr(value)
		}
		if frame == normalize(url) || strings.Trim(frame, "/") == strings.Trim(path, "/") {
			return artifact, nil
		}
		if resolved, inside := pySafeResolve(frame, directory); strings.HasPrefix(frame, "/") && inside &&
			pyRelative(resolved, directory) == path {
			return artifact, nil
		}
	}
	return nil, pyValueError("no manifest artifact matches the minified stack frame filename")
}

func loadSourceMap(artifact map[string]any, directory string) (map[string]any, error) {
	sourceMap, isObject := artifact["sourceMap"].(map[string]any)
	if !isObject || !pyTruthy(sourceMap["path"]) {
		return nil, pyValueError("matched artifact is missing source map metadata")
	}
	path := pyStr(sourceMap["path"])
	if !strings.HasPrefix(path, "/") {
		path = directory + "/" + path
	}
	resolved, inside := pySafeResolve(path, directory)
	if !inside {
		return nil, pyValueError("source map path resolves outside the build directory")
	}
	payload, err := readManifest(resolved)
	if err != nil {
		return nil, err
	}
	var mapDebugID any
	for _, key := range jsDebugIDKeys {
		if mapDebugID = payload[key]; pyTruthy(mapDebugID) {
			break
		}
	}
	sources, _ := payload["sources"].([]any)
	mappings, _ := payload["mappings"].(string)
	_, hasContent := payload["sourcesContent"]
	switch {
	case hasContent:
		return nil, pyValueError("source map still contains sourcesContent; strip it before symbolication proof")
	case pyTruthy(artifact["debugId"]) && pyTruthy(mapDebugID) && !pyEqual(artifact["debugId"], mapDebugID):
		return nil, pyValueError("matched artifact debug ID does not match source map debug ID")
	case len(sources) == 0:
		return nil, pyValueError("source map sources must be a non-empty array")
	case mappings == "":
		return nil, pyValueError("source map mappings must be a non-empty string")
	}
	return payload, nil
}

// decodeMappings decodes source map mappings into segments of one, four,
// or five absolute values.
func decodeMappings(mappings string) ([][][]int64, error) {
	lines, state := [][][]int64{}, make([]int64, 5)
	for _, raw := range strings.Split(mappings, ";") {
		line := [][]int64{}
		state[0] = 0
		for _, segment := range strings.Split(raw, ",") {
			values, value, shift := []int64{}, int64(0), 0
			for _, character := range segment {
				digit := strings.IndexRune(jsVLQAlphabet, character)
				if digit < 0 {
					return nil, pyValueError("source map mappings contain an invalid base64 VLQ character")
				}
				value += int64(digit&31) << shift
				if digit&32 != 0 {
					shift += 5
					continue
				}
				values = append(values, map[bool]int64{true: -1, false: 1}[value&1 == 1]*(value>>1))
				value, shift = 0, 0
			}
			switch {
			case shift != 0:
				return nil, pyValueError("source map mappings contain an unterminated base64 VLQ value")
			case segment == "":
				continue
			case len(values) != 1 && len(values) != 4 && len(values) != 5:
				return nil, pyValueError("source map segment must contain 1, 4, or 5 VLQ fields")
			}
			decoded := []int64{}
			for index, value := range values {
				state[index] += value
				decoded = append(decoded, state[index])
			}
			line = append(line, decoded)
		}
		lines = append(lines, line)
	}
	return lines, nil
}

func originalPosition(payload map[string]any, line, column int64) (map[string]any, error) {
	lines, err := decodeMappings(payload["mappings"].(string))
	if err != nil {
		return nil, err
	}
	if line-1 >= int64(len(lines)) {
		return nil, pyValueError("generated line is outside source map mappings")
	}
	var best []int64
	for _, segment := range lines[line-1] {
		if segment[0] > column-1 {
			break
		}
		best = segment
	}
	if len(best) < 4 {
		return nil, pyValueError("no original source mapping found for generated frame")
	}
	sources := payload["sources"].([]any)
	if best[1] < 0 || best[1] >= int64(len(sources)) {
		return nil, pyValueError("source map segment references an invalid source index")
	}
	text, isString := sources[best[1]].(string)
	source := fileReference(pyStrip(text))
	if !isString || source == "" {
		return nil, pyValueError("source map segment references an invalid source value")
	}
	if parts, err := pyURLSplit(source); err != nil {
		return nil, err
	} else if parts.scheme == "file" || strings.HasPrefix(source, "/") || jsWindowsPathPattern.MatchString(source) {
		return nil, pyValueError("source map source path must be stripped before symbolication proof")
	}
	original := map[string]any{"source": source, "line": best[2] + 1, "column": best[3] + 1}
	if names, isList := payload["names"].([]any); isList && len(best) == 5 && best[4] >= 0 && best[4] < int64(len(names)) {
		if name, isString := names[best[4]].(string); isString && name != "" {
			original["name"] = name
		}
	}
	return original, nil
}

// jsFakeIntake records upload requests for the release artifact smoke checks
// and answers like a release artifact intake. It stops when its port file is
// removed.
func jsFakeIntake(values map[string]*string) int {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	var lock sync.Mutex
	events := []any{}
	writeState := func() {
		text, _ := pyJSONText(map[string]any{"events": events}, "")
		_ = os.WriteFile(*values["state-file"], []byte(text), 0o666)
	}
	parent := pyPurePath(*values["state-file"])
	parent = cmpOr(parent[:max(strings.LastIndex(parent, "/"), 0)], map[bool]string{true: "/"}[strings.HasPrefix(parent, "/")])
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		route := before(request.RequestURI, "?")
		contains := func(text string) bool { return strings.Contains(string(body), text) }
		event := map[string]any{"path": route, "bodyLength": len(body),
			"authorized":               request.Header.Get("Authorization") == "Bearer "+*values["expected-bearer"],
			"containsManifest":         contains("javascript_source_map_manifest"),
			"containsSourceSentinel":   contains(*values["source-sentinel"]),
			"containsAuthValue":        contains(*values["expected-bearer"]),
			"containsQueryPlaceholder": contains(*values["query-placeholder"]),
			"containsHashFragment":     contains(*values["hash-fragment"]),
			"containsTempPath":         contains(cmpOr(parent, ".")),
			"containsSourceMapPart":    contains(`name="source_map_0"`),
			"containsMinifiedPart":     contains(`name="minified_source_0"`)}
		lock.Lock()
		events = append(events, event)
		writeState()
		attempts := 0
		for _, seen := range events {
			attempts += map[bool]int{true: 1}[seen.(map[string]any)["path"] == "/retry-success"]
		}
		lock.Unlock()
		status := http.StatusNotFound
		if route == "/retry-success" {
			status = map[bool]int{true: http.StatusServiceUnavailable, false: http.StatusAccepted}[attempts == 1]
			if !event["authorized"].(bool) {
				status = http.StatusUnauthorized
			}
		}
		writer.WriteHeader(status)
		_, _ = io.WriteString(writer, "{}")
	})
	if err == nil {
		err = os.WriteFile(*values["port-file"], []byte(strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)), 0o666)
	}
	if err != nil {
		panic(nativeStop{exitFailure, err.Error()})
	}
	writeState()
	go func() {
		for pyExists(*values["port-file"]) {
			time.Sleep(100 * time.Millisecond)
		}
		_ = listener.Close()
	}()
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	_ = server.Serve(listener)
	return exitOK
}
