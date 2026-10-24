package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"
)

const (
	releasePlanMode  = "release-plan"
	mavenGroup       = "co.logbrew"
	releasePlanUsage = "usage: release-plan maven create|canonicalize|validate|manifest [flags] | " +
		"release-plan nuget create|validate|canonicalize|entries [flags]\n"
	invalidMavenPlan = "invalid Maven release plan"
	invalidNuGetPlan = "invalid NuGet release plan"
)

var (
	mavenPlanVersion = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$`)
	nugetPlanVersion = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$`)
	sourceCommitSHA  = regexp.MustCompile(`^[0-9a-f]{40}$`)
	// Each command's flags; "a|b" means exactly one of them.
	releasePlanCommands = map[string][]string{
		"maven create":       {"root", "output", "artifact|artifacts|artifacts-env"},
		"maven canonicalize": {"root", "artifacts|artifacts-env"},
		"maven validate":     {"root", "plan"},
		"maven manifest":     {"plan", "stage", "bundle", "source-commit", "output"},
		"nuget create":       {"root", "packages-env", "output"},
		"nuget validate":     {"root", "plan"},
		"nuget canonicalize": {"packages-env"},
		"nuget entries":      {"root", "plan", "format"},
	}
)

// checkReleasePlan creates and validates the exact Maven artifact and NuGet
// package selections that publishing uses.
func checkReleasePlan(arguments []string, lookupEnv func(string) (string, bool), output, diagnostic io.Writer) int {
	flags := flag.NewFlagSet(releasePlanMode, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	values := map[string]*string{}
	for _, name := range []string{"root", "output", "artifacts", "artifacts-env", "plan", "stage", "bundle",
		"source-commit", "packages-env", "format"} {
		values[name] = flags.String(name, "", "")
	}
	var artifacts versionFlags
	flags.Var(&artifacts, "artifact", "")
	var spec []string
	if len(arguments) >= 2 && flags.Parse(arguments[2:]) == nil && flags.NArg() == 0 {
		spec = releasePlanCommands[arguments[0]+" "+arguments[1]]
	}
	set := map[string]bool{}
	flags.Visit(func(used *flag.Flag) { set[used.Name] = true })
	if !flagGroups(spec, set) || set["format"] && !slices.Contains([]string{"ids", "versions", "projects", "mode"},
		*values["format"]) {
		return writeText(diagnostic, releasePlanUsage, exitUsage)
	}
	if arguments[0] == "maven" {
		text, err := mavenPlanCommand(arguments[1], values, artifacts, set, lookupEnv)
		if err != nil {
			return writeText(diagnostic, "Maven release plan failed: "+err.Error()+"\n", exitFailure)
		}
		return writeText(output, text, exitOK)
	}
	text, ok := nugetPlanCommand(arguments[1], values, lookupEnv)
	switch {
	case !ok && arguments[1] == "create":
		return writeText(diagnostic, "invalid NuGet package selection\n", exitFailure)
	case !ok:
		return writeText(diagnostic, invalidNuGetPlan+"\n", exitFailure)
	}
	return writeText(output, text, exitOK)
}

func flagGroups(spec []string, set map[string]bool) bool {
	used := 0
	for _, group := range spec {
		count := 0
		for name := range strings.SplitSeq(group, "|") {
			if set[name] {
				count++
			}
		}
		if count != 1 {
			return false
		}
		used += count
	}
	return len(spec) > 0 && used == len(set)
}

func mavenPlanCommand(command string, values map[string]*string, artifacts []string, set map[string]bool,
	lookupEnv func(string) (string, bool),
) (string, error) {
	catalog, err := loadReleaseCatalog(releaseCatalogText)
	if err != nil {
		return "", err
	}
	root := *values["root"]
	switch command {
	case "create", "canonicalize":
		selected := artifacts
		if !set["artifact"] {
			raw := *values["artifacts"]
			if set["artifacts-env"] {
				raw, _ = lookupEnv(*values["artifacts-env"])
			}
			if selected, err = mavenSelection(raw, catalog.MavenArtifacts); err != nil {
				return "", err
			}
		}
		plan, err := mavenPlan(root, selected, catalog.MavenArtifacts)
		if err != nil {
			return "", err
		}
		if command == "create" {
			return "", writePlanJSON(*values["output"], plan, "  ")
		}
		ids := []string{}
		for _, entry := range plan["selected"].([]any) {
			ids = append(ids, entry.(map[string]any)["artifactId"].(string))
		}
		return strings.Join(ids, ",") + "\n", nil
	case "validate":
		plan, err := loadMavenPlan(*values["plan"])
		var expected map[string]any
		if err == nil {
			expected, err = mavenPlan(root, planIDs(plan["selected"], "artifactId"), catalog.MavenArtifacts)
		}
		if err == nil && !pyEqual(plan, expected) {
			err = errors.New("saved release plan does not match current Maven metadata")
		}
		return "", err
	}
	plan, err := loadMavenPlan(*values["plan"])
	var manifest map[string]any
	if err == nil {
		manifest, err = mavenManifest(plan, *values["stage"], *values["bundle"], *values["source-commit"])
	}
	if err == nil {
		err = writePlanJSON(*values["output"], manifest, "  ")
	}
	return "", err
}

// planIDs returns the string IDs of a saved plan's selection, or nil when the
// selection is malformed.
func planIDs(selected any, key string) []string {
	entries, ok := selected.([]any)
	ids := []string{}
	for _, entry := range entries {
		id, valid := field(entry, key).(string)
		if !valid {
			return nil
		}
		ids = append(ids, id)
	}
	if !ok {
		return nil
	}
	return ids
}

func mavenSelection(raw string, catalog [][]string) ([]string, error) {
	if raw == "" {
		ids := []string{}
		for _, entry := range catalog {
			ids = append(ids, entry[0])
		}
		return ids, nil
	}
	selected := strings.Split(raw, ",")
	for index, id := range selected {
		selected[index] = pyStrip(id)
	}
	if strings.ContainsAny(raw, "\r\n") || slices.Contains(selected, "") {
		return nil, errors.New("invalid Maven artifact selection")
	}
	return selected, nil
}

type mavenPOM struct {
	versions     map[string]string
	version      string
	dependencies []string
}

func mavenPlan(root string, selected []string, catalog [][]string) (map[string]any, error) {
	entries := map[string][]string{}
	for _, entry := range catalog {
		entries[entry[0]] = entry
	}
	switch {
	case selected == nil:
		return nil, errors.New(invalidMavenPlan)
	case len(selected) == 0:
		return nil, errors.New("select at least one Maven artifact")
	case len(slices.Compact(slices.Sorted(slices.Values(selected)))) != len(selected):
		return nil, errors.New("duplicate Maven artifact selection")
	case slices.ContainsFunc(selected, func(id string) bool { return entries[id] == nil }):
		return nil, errors.New("unsupported Maven artifact selection")
	}
	poms := map[string]*mavenPOM{}
	read := func(id string) (*mavenPOM, error) {
		var err error
		if poms[id] == nil {
			poms[id], err = readMavenPOM(root, entries[id], entries)
		}
		return poms[id], err
	}
	chosen, external := []any{}, map[string]any{}
	for _, entry := range catalog {
		if !slices.Contains(selected, entry[0]) {
			continue
		}
		pom, err := read(entry[0])
		if err != nil {
			return nil, err
		}
		for _, id := range pom.dependencies {
			dependency, err := read(id)
			switch {
			case err != nil:
				return nil, err
			case dependency.version != pom.versions[id]:
				return nil, errors.New("dependency version mismatch for " + entry[0])
			case !slices.Contains(selected, id):
				external[id] = map[string]any{"artifactId": id, "coordinate": mavenGroup + ":" + id, "version": dependency.version}
			}
		}
		chosen = append(chosen, map[string]any{"artifactId": entry[0], "coordinate": mavenGroup + ":" + entry[0],
			"packageDir": entry[1], "version": pom.version})
	}
	ordered := []any{}
	for _, entry := range catalog {
		if external[entry[0]] != nil {
			ordered = append(ordered, external[entry[0]])
		}
	}
	return map[string]any{"schemaVersion": json.Number("1"), "selected": chosen, "externalDependencies": ordered}, nil
}

func readMavenPOM(root string, entry []string, catalog map[string][]string) (*mavenPOM, error) {
	id := entry[0]
	data, err := os.ReadFile(filepath.Join(root, entry[1], "pom.xml"))
	var project *xmlElement
	if err == nil {
		project, err = parseUTF8XML(data)
	}
	if err != nil {
		return nil, fmt.Errorf("invalid Maven metadata for %s: %s", id, pyErrorName(err))
	}
	pom := &mavenPOM{versions: map[string]string{}}
	group, err := requiredText(project, "groupId", id)
	artifact, version := "", ""
	if err == nil {
		artifact, err = requiredText(project, "artifactId", id)
	}
	if err == nil {
		version, err = requiredText(project, "version", id)
	}
	switch {
	case err != nil:
		return nil, err
	case group != mavenGroup || artifact != id:
		return nil, fmt.Errorf("unexpected Maven coordinate in %s/pom.xml", entry[1])
	case !mavenPlanVersion.MatchString(version):
		return nil, errors.New("invalid Maven version for " + id)
	}
	pom.version = version
	for _, dependencies := range project.all("dependencies") {
		for _, dependency := range dependencies.all("dependency") {
			if err := pom.addDependency(dependency, id, catalog); err != nil {
				return nil, err
			}
		}
	}
	if !slices.Equal(pom.dependencies, entry[2:]) {
		return nil, errors.New("unexpected internal Maven dependency closure in " + id)
	}
	return pom, nil
}

// requiredText returns a child's stripped text like ElementTree's
// findtext("{*}name"), failing when it is missing or blank.
func requiredText(element *xmlElement, name, id string) (string, error) {
	child := element.child(name)
	if child == nil || child.value == nil || pyStrip(*child.value) == "" {
		return "", fmt.Errorf("missing %s in %s", name, id)
	}
	return pyStrip(*child.value), nil
}

func (pom *mavenPOM) addDependency(dependency *xmlElement, id string, catalog map[string][]string) error {
	group, err := requiredText(dependency, "groupId", id)
	if err != nil || group != mavenGroup {
		return err
	}
	artifact, err := requiredText(dependency, "artifactId", id)
	version := ""
	if err == nil {
		version, err = requiredText(dependency, "version", id)
	}
	switch {
	case err != nil:
		return err
	case catalog[artifact] == nil:
		return errors.New("unsupported internal Maven dependency in " + id)
	case pom.versions[artifact] != "":
		return errors.New("duplicate internal Maven dependency in " + id)
	case !mavenPlanVersion.MatchString(version):
		return errors.New("invalid internal Maven dependency version in " + id)
	}
	pom.dependencies = append(pom.dependencies, artifact)
	pom.versions[artifact] = version
	return nil
}

func loadMavenPlan(path string) (map[string]any, error) {
	value, err := readPlanJSON(path)
	if err != nil {
		return nil, errors.New(invalidMavenPlan + ": " + pyErrorName(err))
	}
	plan, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New(invalidMavenPlan)
	}
	return plan, nil
}

func mavenManifest(plan map[string]any, stage, bundle, commit string) (map[string]any, error) {
	if !sourceCommitSHA.MatchString(commit) {
		return nil, errors.New("source commit must be 40 lowercase hexadecimal characters")
	}
	if !regularFile(bundle) {
		return nil, errors.New("release bundle is missing")
	}
	selected, ok := planField(plan, "selected").([]any)
	if !ok {
		return nil, errors.New(invalidMavenPlan)
	}
	artifacts := []any{}
	for _, value := range selected {
		entry, _ := value.(map[string]any)
		id, idOK := entry["artifactId"].(string)
		version, versionOK := entry["version"].(string)
		if !idOK || !versionOK {
			return nil, errors.New(invalidMavenPlan)
		}
		files, err := stagedFiles(stage, filepath.Join(stage, "co", "logbrew", id, version))
		if err != nil {
			return nil, err
		}
		if len(files) == 0 {
			return nil, errors.New("selected Maven artifact files are missing for " + id)
		}
		artifact := map[string]any{}
		for key, item := range entry {
			artifact[key] = item
		}
		artifact["files"] = files
		artifacts = append(artifacts, artifact)
	}
	digest, err := fileSHA256(bundle)
	return map[string]any{"schemaVersion": json.Number("1"), "sourceCommit": commit,
		"bundle":    map[string]any{"sha256": digest},
		"artifacts": artifacts, "externalDependencies": planField(plan, "externalDependencies"),
	}, err
}

// planField reads an optional plan member like dict.get with a default.
func planField(plan map[string]any, key string) any {
	if value, found := plan[key]; found {
		return value
	}
	return []any{}
}

// stagedFiles lists the regular files under one staged artifact in path
// component order, like sorted pathlib rglob results.
func stagedFiles(stage, root string) ([]any, error) {
	files := []any{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkError error) error {
		if walkError != nil || path == root || !regularFile(path) {
			return nil
		}
		digest, err := fileSHA256(path)
		relative, _ := filepath.Rel(stage, path)
		files = append(files, map[string]any{"path": filepath.ToSlash(relative), "sha256": digest})
		return err
	})
	return files, err
}

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func fileSHA256(path string) (string, error) {
	data, err := os.ReadFile(path)
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), err
}

func nugetPlanCommand(command string, values map[string]*string, lookupEnv func(string) (string, bool)) (string, bool) {
	catalog, err := loadReleaseCatalog(releaseCatalogText)
	if err != nil {
		return "", false
	}
	root := *values["root"]
	if command == "create" || command == "canonicalize" {
		raw, found := lookupEnv(*values["packages-env"])
		selected, ok := nugetSelection(raw, catalog.NuGet)
		switch {
		case !found || !ok:
			return "", false
		case command == "canonicalize" && raw == "":
			return "\n", true
		case command == "canonicalize":
			return strings.Join(selected, ",") + "\n", true
		}
		plan, ok := nugetPlan(root, selected, map[bool]string{true: "all", false: "selected"}[raw == ""], catalog.NuGet)
		return "nuget release plan ok\n", ok && writePlanJSON(*values["output"], plan, "") == nil
	}
	value, err := readPlanJSON(*values["plan"])
	plan, ok := nugetValidPlan(root, value, catalog.NuGet)
	if err != nil || !ok {
		return "", false
	}
	if command == "validate" {
		return "nuget release plan ok\n", true
	}
	if *values["format"] == "mode" {
		return plan["selectionMode"].(string) + "\n", true
	}
	var text strings.Builder
	for _, value := range plan["selected"].([]any) {
		entry := value.(map[string]any)
		text.WriteString(map[string]string{
			"ids":      entry["packageId"].(string),
			"versions": entry["packageId"].(string) + "=" + entry["version"].(string),
			"projects": entry["packageId"].(string) + "\t" + entry["projectPath"].(string) + "\t" + entry["version"].(string),
		}[*values["format"]] + "\n")
	}
	return text.String(), true
}

func nugetIDs(catalog []nugetRelease, selected []string) []string {
	ids := []string{}
	for _, release := range catalog {
		if slices.Contains(selected, release.ID) {
			ids = append(ids, release.ID)
		}
	}
	return ids
}

// releasableNuGet allows the core pair together or one other package alone.
func releasableNuGet(selected []string) bool {
	core := []string{"LogBrew", "LogBrew.HttpClient"}
	return slices.Equal(slices.Sorted(slices.Values(selected)), core) ||
		len(selected) == 1 && !slices.Contains(core, selected[0])
}

func nugetSelection(raw string, catalog []nugetRelease) ([]string, bool) {
	all := []string{}
	for _, release := range catalog {
		all = append(all, release.ID)
	}
	if raw == "" {
		return all, true
	}
	entries := strings.Split(raw, ",")
	for index, entry := range entries {
		entries[index] = pyStrip(entry)
	}
	selected := nugetIDs(catalog, entries)
	// nugetIDs keeps known IDs once each, so equal lengths reject unknown,
	// empty, and repeated entries.
	return selected, !strings.ContainsAny(raw, "\r\n") && len(selected) == len(entries) && releasableNuGet(selected)
}

func nugetPlan(root string, selected []string, mode string, catalog []nugetRelease) (map[string]any, bool) {
	entries := []any{}
	for _, release := range catalog {
		if !slices.Contains(selected, release.ID) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, release.project()))
		var project *xmlElement
		if err == nil {
			project, err = parseUTF8XML(data)
		}
		version, ok := project.findText("", "PropertyGroup", "Version").(string)
		version = pyStrip(version)
		if err != nil || !ok || !nugetPlanVersion.MatchString(version) {
			return nil, false
		}
		entries = append(entries, map[string]any{"packageId": release.ID, "projectPath": release.project(),
			"version": version, "versionOutput": release.VersionOutput})
	}
	return map[string]any{"schemaVersion": json.Number("1"), "selectionMode": mode, "selected": entries}, true
}

func nugetValidPlan(root string, value any, catalog []nugetRelease) (map[string]any, bool) {
	mode, _ := field(value, "selectionMode").(string)
	ids := planIDs(field(value, "selected"), "packageId")
	if !pyEqual(field(value, "schemaVersion"), json.Number("1")) || mode != "all" && mode != "selected" ||
		len(ids) == 0 || !slices.Equal(ids, nugetIDs(catalog, ids)) || mode == "all" && len(ids) != len(catalog) || mode == "selected" && !releasableNuGet(ids) {
		return nil, false
	}
	plan, ok := nugetPlan(root, ids, mode, catalog)
	return plan, ok && pyEqual(value, plan)
}

// readPlanJSON decodes one JSON document with numbers kept exact.
func readPlanJSON(path string) (any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return decodePlanJSON(data)
}

func decodePlanJSON(data []byte) (any, error) {
	if !utf8.Valid(data) {
		return nil, errUnicodeDecode
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return nil, errJSONDecode
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errJSONDecode
	}
	return value, nil
}

var (
	errJSONDecode    = errors.New("JSONDecodeError")
	errUnicodeDecode = errors.New("UnicodeDecodeError")
)

func parseUTF8XML(data []byte) (*xmlElement, error) {
	if !utf8.Valid(data) {
		return nil, errUnicodeDecode
	}
	element, err := parseXML(data)
	if err != nil {
		return nil, errors.New("ParseError")
	}
	return element, nil
}

// pyErrorName names an error the way the Python exception class would.
func pyErrorName(err error) string {
	for _, known := range []struct {
		target error
		name   string
	}{
		{fs.ErrNotExist, "FileNotFoundError"}, {fs.ErrPermission, "PermissionError"},
		{syscall.EISDIR, "IsADirectoryError"}, {syscall.ENOTDIR, "NotADirectoryError"},
	} {
		if errors.Is(err, known.target) {
			return known.name
		}
	}
	var pathError *fs.PathError
	if errors.As(err, &pathError) {
		return "OSError"
	}
	return err.Error()
}

// pyStrip trims the characters Python's str.strip removes.
func pyStrip(text string) string {
	return strings.TrimFunc(text, func(character rune) bool {
		return unicode.IsSpace(character) || character >= 0x1c && character <= 0x1f
	})
}

// pyEqual compares decoded JSON the way Python's == does, so 1, 1.0, and true
// are equal.
func pyEqual(left, right any) bool {
	if leftNumber, ok := pyNumber(left); ok {
		rightNumber, ok := pyNumber(right)
		return ok && leftNumber == rightNumber
	}
	switch left := left.(type) {
	case map[string]any:
		right, ok := right.(map[string]any)
		if !ok || len(left) != len(right) {
			return false
		}
		for key, value := range left {
			if other, found := right[key]; !found || !pyEqual(value, other) {
				return false
			}
		}
		return true
	case []any:
		right, ok := right.([]any)
		return ok && slices.EqualFunc(left, right, pyEqual)
	}
	return left == right
}

func pyNumber(value any) (float64, bool) {
	switch value := value.(type) {
	case json.Number:
		number, _ := strconv.ParseFloat(string(value), 64)
		return number, true
	case bool:
		return map[bool]float64{true: 1}[value], true
	}
	return 0, false
}

// pyJSONNumbers rewrites decoded numbers the way Python's json module prints
// them after loading: integers stay exact and floats use repr().
func pyJSONNumbers(value any) (any, error) {
	switch value := value.(type) {
	case json.Number:
		text := string(value)
		if text == "-0" {
			return json.Number("0"), nil
		}
		if !strings.ContainsAny(text, ".eE") {
			return value, nil
		}
		number, _ := strconv.ParseFloat(text, 64)
		if math.IsInf(number, 0) {
			return nil, errors.New("float out of range")
		}
		exponent, _ := strconv.Atoi(after(strconv.FormatFloat(number, 'e', -1, 64), "e"))
		if exponent < -4 || exponent >= 16 {
			return json.Number(strconv.FormatFloat(number, 'e', -1, 64)), nil
		}
		text = strconv.FormatFloat(number, 'f', -1, 64)
		if !strings.Contains(text, ".") {
			text += ".0"
		}
		return json.Number(text), nil
	case map[string]any:
		copied := map[string]any{}
		for key, item := range value {
			converted, err := pyJSONNumbers(item)
			if err != nil {
				return nil, err
			}
			copied[key] = converted
		}
		return copied, nil
	case []any:
		copied := []any{}
		for _, item := range value {
			converted, err := pyJSONNumbers(item)
			if err != nil {
				return nil, err
			}
			copied = append(copied, converted)
		}
		return copied, nil
	}
	return value, nil
}

// writePlanJSON atomically writes sorted, ASCII-only JSON like Python's
// json.dump with sort_keys, indented by indent or compact when it is empty.
func writePlanJSON(path string, value any, indent string) error {
	text, err := pyJSONText(value, indent)
	if err == nil {
		err = os.MkdirAll(filepath.Dir(path), 0o777)
	}
	var temporary *os.File
	if err == nil {
		temporary, err = os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	}
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	_, err = temporary.WriteString(text)
	return errors.Join(err, temporary.Sync(), temporary.Close(), os.Rename(temporary.Name(), path))
}

// pyJSONText encodes sorted, ASCII-only JSON like Python's json.dumps with
// sort_keys, indented by indent or compact when it is empty, plus a newline.
func pyJSONText(value any, indent string) (string, error) {
	value, err := pyJSONNumbers(value)
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", indent)
	if err == nil {
		err = encoder.Encode(value)
	}
	var text strings.Builder
	for _, character := range encoded.String() {
		switch {
		case character < utf8.RuneSelf-1:
			text.WriteRune(character)
		case character > 0xffff:
			character -= 0x10000
			fmt.Fprintf(&text, `\u%04x\u%04x`, 0xd800+character>>10, 0xdc00+character&0x3ff)
		default:
			fmt.Fprintf(&text, `\u%04x`, character)
		}
	}
	return text.String(), err
}
