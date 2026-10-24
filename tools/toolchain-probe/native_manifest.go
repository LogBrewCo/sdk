package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	nativeManifestUsage = "usage: release-artifacts native-manifest --release RELEASE --environment ENVIRONMENT " +
		"--service SERVICE --artifact TYPE=PATH [--artifact TYPE=PATH...] [--artifact-root DIRECTORY] " +
		"[--repository-url URL] [--commit-sha SHA] [--max-symbol-files COUNT] [--max-symbol-file-bytes BYTES] " +
		"[--max-artifact-bytes BYTES]\n"
	unityBuildIDName = "build_id"
	unityMappingName = "LineNumberMappings.json"
	// pySpaceClass holds the characters Python's \s and str.isspace accept.
	pySpaceClass = `\t-\r\x1c-\x20\x{85}\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}`
)

var (
	nativeArtifactTypes = []string{
		"ios_dsym", "android_proguard_mapping", "android_native_symbols", "unity_symbols", "breakpad_symbols", "dotnet_pdb",
	}
	nativeLimitFlags       = []string{"max-symbol-files", "max-symbol-file-bytes", "max-artifact-bytes"}
	proguardClassPattern   = regexp.MustCompile(`^[` + pySpaceClass + `]*[^#` + pySpaceClass + `].+?[` + pySpaceClass + `]+->[` + pySpaceClass + `]+[^:]+:[` + pySpaceClass + `]*$`)
	unityBuildIDPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	symbolSourcePriorities = map[any]int{"debug_info": 3, "symbol_table": 2, "dynamic_symbol_table": 1}
)

// nativeStop ends the manifest command the way an uncaught Python exception
// ended the script: code 2 with a message for invalid input, code 1 otherwise.
type nativeStop struct {
	code    int
	message string
}

// nativeArtifact collects one artifact's findings.
type nativeArtifact struct {
	root             string
	limits           []int64
	errors, warnings []string
}

// checkNativeManifest validates native and mobile debug-symbol artifacts and
// prints their dry-run upload manifest.
func checkNativeManifest(arguments []string, output, diagnostic io.Writer) (code int) {
	defer func() {
		// Any other panic fails the conversion and still crashes.
		if value := recover(); value != nil {
			stop := value.(nativeStop)
			code = writeText(diagnostic, stop.message+"\n", stop.code)
		}
	}()
	flags := flag.NewFlagSet(releaseArtifactsMode, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	values := map[string]*string{}
	for _, name := range append([]string{"artifact-root", "release", "environment", "service", "repository-url",
		"commit-sha"}, nativeLimitFlags...) {
		values[name] = flags.String(name, "", "")
	}
	var specs versionFlags
	flags.Var(&specs, "artifact", "")
	valid := flags.Parse(arguments) == nil && flags.NArg() == 0
	set := map[string]bool{}
	flags.Visit(func(used *flag.Flag) { set[used.Name] = true })
	limits := []int64{500, 2 << 30, 2 << 30}
	for index, name := range nativeLimitFlags {
		if set[name] {
			value, parsed := pyInt(*values[name], 10, false)
			valid, limits[index] = valid && parsed && value > 0, value
		}
	}
	if !valid || !set["release"] || !set["environment"] || !set["service"] || len(specs) == 0 {
		return writeText(diagnostic, nativeManifestUsage, exitUsage)
	}
	failed := func(message string) nativeStop {
		return nativeStop{exitUsage, "manifest validation failed: " + message}
	}
	kinds, paths := []string{}, []string{}
	for _, spec := range specs {
		kind, path, found := strings.Cut(spec, "=")
		kind, path = pyStrip(kind), pyStrip(path)
		switch {
		case !found:
			panic(failed("artifact must use TYPE=PATH syntax"))
		case !slices.Contains(nativeArtifactTypes, kind):
			panic(failed("unsupported artifact type: " + kind + "; supported types: " + strings.Join(nativeArtifactTypes, ", ")))
		case path == "":
			panic(failed("artifact path is required"))
		}
		kinds, paths = append(kinds, kind), append(paths, pyPath(path))
	}
	manifest := map[string]any{"manifestVersion": 1, "artifactType": "native_debug_symbol_manifest",
		"supportedArtifactTypes": nativeArtifactTypes,
		"uploader":               map[string]any{"name": "logbrew-native-release-artifact-manifest", "version": "0.1.0"},
		"limits":                 map[string]any{"maxSymbolFiles": limits[0], "maxSymbolFileBytes": limits[1], "maxArtifactBytes": limits[2]},
	}
	for _, name := range []string{"release", "environment", "service"} {
		if manifest[name] = pyStrip(*values[name]); manifest[name] == "" {
			panic(failed(name + " is required"))
		}
	}
	root, _ := filepath.Abs(cmpOr(*values["artifact-root"], "."))
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		panic(failed("artifact root does not exist: " + root))
	}
	entries, errors, warnings := []any{}, []string{}, []string{}
	for index, kind := range kinds {
		path := paths[index]
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, path)
		}
		if relative, _ := filepath.Rel(root, path); relative == ".." || strings.HasPrefix(relative, "../") {
			panic(failed("artifact path must stay inside artifact root: " + paths[index]))
		}
		artifact := &nativeArtifact{root: root, limits: limits, errors: []string{}, warnings: []string{}}
		entry := artifact.entry(kind, filepath.Clean(path))
		for _, message := range artifact.errors {
			errors = append(errors, entry["path"].(string)+": "+message)
		}
		for _, message := range artifact.warnings {
			warnings = append(warnings, entry["path"].(string)+": "+message)
		}
		entries = append(entries, entry)
	}
	git := map[string]any{}
	for name, key := range map[string]string{"repository-url": "repositoryUrl", "commit-sha": "commitSha"} {
		if *values[name] != "" {
			git[key] = pyStrip(*values[name])
		}
	}
	if len(git) > 0 {
		manifest["git"] = git
	}
	manifest["artifacts"], manifest["validation"] = entries, nativeValidation(errors, warnings)
	text, _ := pyJSONText(manifest, "  ")
	return writeText(output, text, map[bool]int{true: exitFailure}[len(errors) > 0])
}

func nativeValidation(errors, warnings []string) map[string]any {
	return map[string]any{"status": map[bool]string{true: "blocked", false: "ready"}[len(errors) > 0],
		"errors": errors, "warnings": warnings}
}

// entry validates one artifact and, when it is ready, records its identity.
func (artifact *nativeArtifact) entry(kind, path string) map[string]any {
	details := map[string]any{}
	switch kind {
	case "ios_dsym":
		artifact.dsym(path, details)
	case "android_proguard_mapping":
		artifact.proguard(path, details)
	case "unity_symbols":
		artifact.unity(path, details)
	default:
		artifact.symbols(kind, path, details)
	}
	entry := map[string]any{"artifactType": kind, "path": artifact.relative(path),
		"validation": nativeValidation(artifact.errors, artifact.warnings)}
	maps.Copy(entry, details)
	if _, err := os.Stat(path); err == nil && len(artifact.errors) == 0 {
		files, size, digest := nativeFiles(path, nil), int64(0), sha256.New()
		for _, file := range files {
			fileSize := nativeSize(file)
			size += fileSize
			if !nativeRegular(path) {
				fmt.Fprintf(digest, "%s\x00%s\x00%d\x00", artifact.relative(file), nativeSHA256(file), fileSize)
			}
		}
		sum := hex.EncodeToString(digest.Sum(nil))
		if nativeRegular(path) {
			sum = nativeSHA256(path)
		}
		maps.Copy(entry, map[string]any{"artifactId": "lbw_" + kind + "_" + sum[:32], "artifactSha256": sum,
			"byteSize": size, "fileCount": len(files)})
	}
	return entry
}

func (artifact *nativeArtifact) relative(path string) string {
	relative, _ := filepath.Rel(artifact.root, path)
	return relative
}

// prepare rejects symbolic links and oversized artifacts, and reports whether
// the artifact may be read.
func (artifact *nativeArtifact) prepare(label, path string) bool {
	paths := []string{path}
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		paths = append(paths, nativeWalk(path)...)
	}
	for _, candidate := range paths {
		if info, err := os.Lstat(candidate); err == nil && info.Mode()&fs.ModeSymlink != 0 {
			artifact.fail("symbolic links are not accepted in release artifacts: " + artifact.relative(candidate))
		}
	}
	if len(artifact.errors) > 0 {
		return false
	}
	size := int64(0)
	for _, file := range nativeFiles(path, nil) {
		size += nativeSize(file)
	}
	if size > artifact.limits[2] {
		artifact.fail(fmt.Sprintf("%s artifact is %d bytes; maximum is %d bytes", label, size, artifact.limits[2]))
	}
	return true
}

// accept applies the symbol file count and size limits.
func (artifact *nativeArtifact) accept(label string, candidates []string) []string {
	if len(candidates) > int(artifact.limits[0]) {
		artifact.fail(fmt.Sprintf("%s contains %d symbol files; maximum is %d", label, len(candidates), artifact.limits[0]))
		return nil
	}
	return slices.DeleteFunc(candidates, func(candidate string) bool {
		return !artifact.fitSymbol(artifact.relative(candidate), "symbol", nativeSize(candidate))
	})
}

func (artifact *nativeArtifact) fitSymbol(location, kind string, size int64) bool {
	if size > artifact.limits[1] {
		artifact.fail(fmt.Sprintf("%s: %s file is %d bytes; maximum is %d bytes", location, kind, size, artifact.limits[1]))
	}
	return size <= artifact.limits[1]
}

func (artifact *nativeArtifact) fail(messages ...string) {
	artifact.errors = append(artifact.errors, messages...)
}

func (artifact *nativeArtifact) warn(messages ...string) {
	artifact.warnings = append(artifact.warnings, messages...)
}

func (artifact *nativeArtifact) dsym(path string, details map[string]any) {
	dwarfFiles, uuidCount, bundleName, bundleCount, archive, hasInfoPlist := []any{}, 0, filepath.Base(path), 1, false, false
	info, err := os.Stat(path)
	switch {
	case err != nil:
		artifact.fail("dSYM bundle is missing")
	case info.Mode().IsRegular() && strings.EqualFold(pySuffix(path), ".zip"):
		archive = true
		if artifact.prepare("dSYM", path) {
			var bundles []string
			bundles, hasInfoPlist, dwarfFiles, uuidCount = artifact.dsymArchive(path)
			if bundleCount = len(bundles); bundleCount == 1 {
				bundleName = bundles[0]
			}
		}
	case !info.IsDir():
		artifact.fail("dSYM artifact must be a .dSYM directory or .zip archive")
	case !strings.HasSuffix(bundleName, ".dSYM"):
		artifact.fail("dSYM artifact directory must end with .dSYM")
	default:
		var accepted []string
		if artifact.prepare("dSYM", path) {
			dwarf := filepath.Join(path, "Contents", "Resources", "DWARF")
			entries, err := os.ReadDir(dwarf)
			if err != nil {
				artifact.fail("dSYM bundle is missing Contents/Resources/DWARF")
			}
			candidates := []string{}
			for _, entry := range entries {
				if nativeRegular(filepath.Join(dwarf, entry.Name())) {
					candidates = append(candidates, filepath.Join(dwarf, entry.Name()))
				}
			}
			accepted = artifact.accept("dSYM DWARF directory", slices.Clone(candidates))
			if err == nil && len(candidates) == 0 {
				artifact.fail("dSYM DWARF directory has no object files")
			}
			for _, candidate := range accepted {
				location, size := artifact.relative(candidate), nativeSize(candidate)
				if size == 0 {
					artifact.fail(location + ": DWARF object file is empty")
					continue
				}
				file, closer := openNativeFile(candidate)
				entry, count := artifact.dwarfEntry(location, size, file)
				closer()
				dwarfFiles, uuidCount = append(dwarfFiles, entry), uuidCount+count
			}
			hasInfoPlist = nativeRegular(filepath.Join(path, "Contents", "Info.plist"))
		}
		if !hasInfoPlist {
			artifact.warn("dSYM Info.plist is missing; platform tooling may reject this bundle")
		}
		if len(accepted) > 0 && uuidCount == 0 {
			artifact.warn("dSYM UUIDs were not found; symbolication upload will need valid Mach-O DWARF objects")
		}
	}
	if err == nil && (info.IsDir() || archive) {
		dsym := map[string]any{"bundleName": bundleName, "bundleCount": bundleCount, "uuidCount": uuidCount,
			"dwarfFiles": dwarfFiles, "hasInfoPlist": hasInfoPlist}
		if archive {
			dsym["archiveFormat"] = "zip"
		}
		details["dsym"] = dsym
	}
}

// dwarfEntry describes one DWARF object and counts its UUIDs.
func (artifact *nativeArtifact) dwarfEntry(location string, size int64, file nativeFile) (map[string]any, int) {
	entry := map[string]any{"path": location, "byteSize": size}
	uuids, failure := machoUUIDs(file)
	if len(uuids) == 0 {
		artifact.warn(location + ": Mach-O UUID was not found (" + failure + ")")
		return entry, 0
	}
	entry["uuids"], entry["uuidCount"] = uuids, len(uuids)
	return entry, len(uuids)
}

func (artifact *nativeArtifact) dsymArchive(path string) ([]string, bool, []any, int) {
	location := artifact.relative(path)
	entries, failures := nativeZip(path, "dSYM archive")
	if artifact.fail(failures...); entries == nil {
		return nil, false, []any{}, 0
	}
	bundles, plists, dwarf, owners := map[string]bool{}, map[string]bool{}, []string{}, []string{}
	for _, name := range slices.Sorted(maps.Keys(entries)) {
		parts := strings.Split(name, "/")
		index := slices.IndexFunc(parts, func(part string) bool { return strings.HasSuffix(part, ".dSYM") })
		if index < 0 {
			continue
		}
		suffix := strings.Join(parts[index+1:], "/")
		bundles[parts[index]], plists[parts[index]] = true, plists[parts[index]] || suffix == "Contents/Info.plist"
		if len(parts)-index == 5 && strings.HasPrefix(suffix, "Contents/Resources/DWARF/") {
			dwarf, owners = append(dwarf, name), append(owners, parts[index])
		}
	}
	if len(bundles) == 0 {
		artifact.fail("dSYM archive contains no .dSYM bundles")
	}
	if len(dwarf) == 0 {
		artifact.fail("dSYM archive contains no DWARF object files")
	}
	if len(dwarf) > int(artifact.limits[0]) {
		artifact.fail(fmt.Sprintf("dSYM archive contains %d DWARF object files; maximum is %d", len(dwarf), artifact.limits[0]))
		dwarf = nil
	}
	dwarfFiles, uuidCount := []any{}, 0
	for index, name := range dwarf {
		member, display := entries[name], location+"!"+name
		if member.size == 0 {
			artifact.fail(display + ": DWARF object file is empty")
			continue
		}
		if !artifact.fitSymbol(display, "symbol", int64(member.size)) {
			continue
		}
		entry, count := artifact.dwarfEntry(display, int64(member.size), nativeMember(member))
		entry["bundleName"] = owners[index]
		dwarfFiles, uuidCount = append(dwarfFiles, entry), uuidCount+count
	}
	names := slices.Sorted(maps.Keys(bundles))
	hasInfoPlist := len(names) > 0 && !slices.ContainsFunc(names, func(name string) bool { return !plists[name] })
	if len(names) > 0 && !hasInfoPlist {
		artifact.warn("dSYM Info.plist is missing; platform tooling may reject this bundle")
	}
	if len(dwarfFiles) > 0 && uuidCount == 0 {
		artifact.warn("dSYM UUIDs were not found; symbolication upload will need valid Mach-O DWARF objects")
	}
	return names, hasInfoPlist, dwarfFiles, uuidCount
}

func (artifact *nativeArtifact) proguard(path string, details map[string]any) {
	info, err := os.Stat(path)
	if err != nil {
		artifact.fail("ProGuard/R8 mapping file is missing")
		return
	}
	if !info.Mode().IsRegular() {
		artifact.fail("ProGuard/R8 mapping artifact must be a file")
		return
	}
	lines, classes := []string{}, 0
	if artifact.prepare("ProGuard/R8 mapping", path) && artifact.fitSymbol(artifact.relative(path), "symbol", info.Size()) {
		data, _ := os.ReadFile(path)
		lines = pySplitLines(pyUTF8(data))
		for _, line := range lines {
			if proguardClassPattern.MatchString(line) {
				classes++
			}
		}
		if info.Size() == 0 {
			artifact.fail("ProGuard/R8 mapping file is empty")
		} else if classes == 0 {
			artifact.fail("ProGuard/R8 mapping file has no class mapping entries")
		}
	}
	if filepath.Base(path) != "mapping.txt" {
		artifact.warn("ProGuard/R8 mapping files are conventionally named mapping.txt")
	}
	details["proguard"] = map[string]any{"mappingFileName": filepath.Base(path), "lineCount": len(lines),
		"classMappingCount": classes}
}

// symbols validates Android native, Breakpad, and PE symbol artifacts.
func (artifact *nativeArtifact) symbols(kind, path string, details map[string]any) {
	label := map[string]string{"android_native_symbols": "Android native symbols", "breakpad_symbols": "Breakpad symbols",
		"dotnet_pdb": "PDB symbols"}[kind]
	files := []map[string]any{}
	info, err := os.Stat(path)
	switch {
	case err != nil:
		artifact.fail(label + " artifact is missing")
	case !info.Mode().IsRegular() && !info.IsDir():
		artifact.fail(label + " artifact must be a " + map[string]string{"android_native_symbols": ".so file",
			"breakpad_symbols": ".sym file", "dotnet_pdb": ".dll/.exe PE file"}[kind] + " or directory")
	case artifact.prepare(label, path):
		candidates := nativeFiles(path, map[string]func(string) bool{
			"android_native_symbols": func(name string) bool { return info.IsDir() && !strings.HasSuffix(name, ".so") },
			"breakpad_symbols": func(name string) bool {
				if info.IsDir() {
					return !strings.HasSuffix(name, ".sym")
				}
				return !strings.EqualFold(pySuffix(name), ".sym")
			},
			"dotnet_pdb": func(name string) bool {
				return !slices.Contains([]string{".dll", ".exe"}, strings.ToLower(pySuffix(name)))
			},
		}[kind])
		if len(candidates) == 0 {
			artifact.fail(label + " artifact contains no " + map[string]string{"android_native_symbols": ".so files",
				"breakpad_symbols": ".sym files", "dotnet_pdb": ".dll or .exe PE files"}[kind])
		}
		for _, candidate := range artifact.accept(label+" artifact", candidates) {
			switch kind {
			case "android_native_symbols":
				files = artifact.elf(files, candidate, nil)
			case "breakpad_symbols":
				files = artifact.breakpad(files, candidate)
			default:
				files = artifact.pe(files, candidate)
			}
		}
		if kind == "android_native_symbols" {
			files = artifact.dedupe(files, "Android native symbol")
		} else {
			files = artifact.dedupe(files, map[string]string{"breakpad_symbols": "Breakpad", "dotnet_pdb": "PDB"}[kind]+" symbol")
		}
	}
	key := map[string]string{"android_native_symbols": "androidNativeSymbols", "breakpad_symbols": "breakpadSymbols",
		"dotnet_pdb": "dotnetPdb"}[kind]
	details[key] = map[string]any{"symbolFileCount": len(files), "architectures": nativeArchitectures(files),
		"files": files}
}

// elf validates one ELF symbol file and appends its record.
func (artifact *nativeArtifact) elf(files []map[string]any, path string, extra map[string]any) []map[string]any {
	file, closer := openNativeFile(path)
	defer closer()
	return artifact.elfFile(files, file, artifact.relative(path), extra)
}

func (artifact *nativeArtifact) elfFile(files []map[string]any, file nativeFile, location string,
	extra map[string]any) []map[string]any {
	if file.size == 0 {
		artifact.fail(location + ": ELF file is empty")
		return files
	}
	record, failure := readELF(file)
	if failure == "" && record["elfTypeCode"] != uint16(2) && record["elfTypeCode"] != uint16(3) {
		failure = "unsupported ELF type " + record["elfType"].(string)
	} else if failure == "" && strings.HasPrefix(record["arch"].(string), "unknown(") {
		failure = "unsupported ELF architecture " + record["arch"].(string)
	}
	source := "none"
	for _, candidate := range [][2]string{{"hasDynamicSymbolTable", "dynamic_symbol_table"},
		{"hasSymbolTable", "symbol_table"}, {"hasDebugInfo", "debug_info"}} {
		if record[candidate[0]] == true {
			source = candidate[1]
		}
	}
	switch {
	case failure != "":
	case record["gnuBuildId"] == "" && record["goBuildId"] == "" && record["fileSha256"] == "":
		failure = "ELF file has no build ID or code hash"
	case source == "none":
		failure = "ELF file has no debug info or symbol tables"
	}
	if failure != "" {
		artifact.fail(location + ": " + failure)
		return files
	}
	if source == "dynamic_symbol_table" {
		artifact.warn(location + ": only dynamic symbols found; full symbolication usually needs unstripped symbols")
	}
	if record["gnuBuildId"] == "" && record["goBuildId"] == "" {
		artifact.warn(location + ": no ELF build ID found; dry run falls back to file hash")
	}
	entry := map[string]any{"path": location, "byteSize": file.size, "symbolSource": source}
	for _, key := range []string{"elfClass", "elfType", "arch", "hasCode", "gnuBuildId", "goBuildId", "fileSha256"} {
		if record[key] != "" {
			entry[key] = record[key]
		}
	}
	maps.Copy(entry, extra)
	return append(files, entry)
}

func (artifact *nativeArtifact) breakpad(files []map[string]any, path string) []map[string]any {
	location, size := artifact.relative(path), nativeSize(path)
	if size == 0 {
		artifact.fail(location + ": Breakpad symbol file is empty")
		return files
	}
	record, failure := readBreakpad(path)
	if failure != "" {
		artifact.fail(location + ": " + failure)
		return files
	}
	if strings.HasPrefix(record["arch"].(string), "unknown(") {
		artifact.warn(location + ": Breakpad MODULE CPU is not mapped: " + record["cpu"].(string))
	}
	record["path"], record["byteSize"] = location, size
	return append(files, record)
}

// pe validates one PE file and the PDB that belongs to it.
func (artifact *nativeArtifact) pe(files []map[string]any, path string) []map[string]any {
	location, size := artifact.relative(path), nativeSize(path)
	if size == 0 {
		artifact.fail(location + ": PE file is empty")
		return files
	}
	file, closer := openNativeFile(path)
	record, failure := readPE(file)
	closer()
	if failure != "" {
		artifact.fail(location + ": " + failure)
		return files
	}
	if strings.HasPrefix(record["arch"].(string), "unknown(") {
		artifact.warn(location + ": PE machine architecture is not mapped: " + record["arch"].(string))
	}
	stem := strings.TrimSuffix(filepath.Base(path), pySuffix(path))
	pdbPath, pdb, pdbLocation := "", map[string]any{}, ""
	for _, candidate := range []string{filepath.Join(filepath.Dir(path), record["pdbFileName"].(string)),
		filepath.Join(filepath.Dir(path), stem+".pdb")} {
		if pdbPath == "" && nativeRegular(candidate) {
			pdbPath = candidate
		}
	}
	pdbSize := int64(0)
	if pdbPath == "" {
		embedded, found := record["embeddedPortablePdb"].(map[string]any)
		if !found {
			artifact.fail(location + ": associated PDB file was not found")
			return files
		}
		pdb, pdbSize = embedded, int64(embedded["uncompressedByteSize"].(uint32))
	} else {
		pdbLocation, pdbSize = artifact.relative(pdbPath), nativeSize(pdbPath)
		if pdbSize == 0 {
			failure = "PDB file is empty"
		} else if artifact.fitSymbol(pdbLocation, "symbol", pdbSize) {
			data, _ := os.ReadFile(pdbPath)
			pdb, failure = readPDB(data)
		} else {
			return files
		}
		if failure != "" {
			artifact.fail(pdbLocation + ": " + failure)
			return files
		}
	}
	format := pdb["pdbFormat"].(string)
	names := map[string]string{"embedded_portable_pdb": "embedded Portable PDB", "windows_pdb": "Windows PDB",
		"portable_pdb": "Portable PDB"}
	if names[format] == "" {
		artifact.warn(cmpOr(pdbLocation, location) + ": PDB payload format is not recognized; " +
			"PE CodeView identity could not be cross-checked")
	} else if pdb["pdbDebugId"] != record["pdbDebugId"] {
		artifact.fail(fmt.Sprintf("%s: %s debug ID %s does not match PE CodeView debug ID %s",
			cmpOr(pdbLocation, location), names[format], pdb["pdbDebugId"], record["pdbDebugId"]))
		return files
	}
	entry := map[string]any{"path": location, "byteSize": size, "pdbByteSize": pdbSize, "pdbFormat": format}
	for _, key := range []string{"peClass", "arch", "pdbGuid", "pdbAge", "pdbDebugId", "pdbFileName", "symbolSource"} {
		entry[key] = record[key]
	}
	if pdbLocation != "" {
		entry["pdbPath"] = pdbLocation
	}
	if names[format] != "" {
		entry["pdbPayloadDebugId"] = pdb["pdbDebugId"]
	}
	if format == "embedded_portable_pdb" {
		entry["pdbEmbeddedCompressedByteSize"] = pdb["compressedByteSize"]
	}
	return append(files, entry)
}

func (artifact *nativeArtifact) unity(path string, details map[string]any) {
	buildID, native, mapping, archive := "", []map[string]any{}, map[string]any(nil), false
	info, err := os.Stat(path)
	switch {
	case err != nil:
		artifact.fail("Unity symbols artifact is missing")
	case info.Mode().IsRegular() && strings.EqualFold(pySuffix(path), ".zip"):
		if artifact.prepare("Unity symbols", path) {
			buildID, native, mapping = artifact.unityArchive(path)
			archive = true
		}
	case !info.IsDir():
		artifact.fail("Unity symbols artifact must be a directory or .zip archive")
	default:
		usable := artifact.prepare("Unity symbols", path)
		buildIDPath, mappingPath := filepath.Join(path, unityBuildIDName), filepath.Join(path, unityMappingName)
		candidates := []string{}
		if usable {
			candidates = nativeFiles(path, func(name string) bool { return !strings.HasSuffix(name, ".so") })
			if nativeRegular(mappingPath) {
				candidates = append(candidates, mappingPath)
			}
			switch {
			case !nativeRegular(buildIDPath):
				artifact.fail("Unity symbols artifact is missing " + unityBuildIDName)
			case artifact.fitSymbol(artifact.relative(buildIDPath), "build_id", nativeSize(buildIDPath)):
				data, _ := os.ReadFile(buildIDPath)
				var failure string
				if buildID, failure = unityBuildID(data); failure != "" {
					artifact.fail(artifact.relative(buildIDPath) + ": " + failure)
				}
			}
		}
		accepted := artifact.accept("Unity symbols artifact", slices.Clone(candidates))
		if usable && len(candidates) == 0 {
			artifact.fail("Unity symbols artifact contains no .so files or " + unityMappingName)
		}
		for _, candidate := range accepted {
			if candidate != mappingPath {
				native = artifact.elf(native, candidate, map[string]any{"symbolFormat": "elf"})
			}
		}
		native = artifact.dedupe(native, "Unity native symbol")
		if slices.Contains(accepted, mappingPath) && nativeRegular(mappingPath) {
			file, closer := openNativeFile(mappingPath)
			head, _ := io.ReadAll(io.NewSectionReader(file, 0, 4096))
			closer()
			var failure string
			if mapping, failure = il2cppMapping(artifact.relative(mappingPath), file.size, head); failure != "" {
				artifact.fail(artifact.relative(mappingPath) + ": " + failure)
			}
		} else if usable {
			artifact.warn(unityMappingName + " is missing; managed Unity stack deobfuscation will be incomplete")
		}
	}
	files := slices.Clone(native)
	if mapping != nil {
		files = append(files, mapping)
	}
	unity := map[string]any{"buildId": buildID, "symbolFileCount": len(files), "nativeSymbolFileCount": len(native),
		"il2cppMappingFileCount": len(files) - len(native), "architectures": nativeArchitectures(native), "files": files}
	if archive {
		unity["archiveFormat"] = "zip"
	}
	details["unitySymbols"] = unity
}

func (artifact *nativeArtifact) unityArchive(path string) (string, []map[string]any, map[string]any) {
	location, inner := artifact.relative(path), &nativeArtifact{limits: artifact.limits}
	buildID, native, mapping, candidates := "", []map[string]any{}, map[string]any(nil), []nativeFile{}
	entries, failures := nativeZip(path, "Unity symbols archive")
	inner.fail(failures...)
	named := func(wanted string) []string {
		return slices.DeleteFunc(slices.Sorted(maps.Keys(entries)), func(name string) bool { return pathBase(name) != wanted })
	}
	names := []string{}
	if entries != nil {
		switch builds := named(unityBuildIDName); {
		case len(builds) > 1:
			inner.fail("Unity symbols archive contains multiple " + unityBuildIDName + " files")
		case len(builds) == 0:
			inner.fail("Unity symbols archive is missing " + unityBuildIDName)
		case inner.fitSymbol(location+"!"+builds[0], "build_id", int64(entries[builds[0]].size)):
			value, failure := unityBuildID(nativeRead(entries[builds[0]]))
			if buildID = value; failure != "" {
				inner.fail(location + "!" + builds[0] + ": " + failure)
			}
		}
		switch mappings := named(unityMappingName); {
		case len(mappings) > 1:
			inner.fail("Unity symbols archive contains multiple " + unityMappingName + " files")
		case len(mappings) == 0:
			inner.warn(unityMappingName + " is missing; managed Unity stack deobfuscation will be incomplete")
		case inner.fitSymbol(location+"!"+mappings[0], "symbol", int64(entries[mappings[0]].size)):
			member, display := entries[mappings[0]], location+"!"+mappings[0]
			value, failure := il2cppMapping(display, int64(member.size), nativeHead(member))
			if mapping = value; failure != "" {
				inner.fail(display + ": " + failure)
			}
		}
		for _, name := range slices.Sorted(maps.Keys(entries)) {
			if strings.HasSuffix(name, ".so") && inner.fitSymbol(location+"!"+name, "symbol", int64(entries[name].size)) {
				candidates, names = append(candidates, nativeMember(entries[name])), append(names, location+"!"+name)
			}
		}
	}
	for _, message := range inner.errors {
		artifact.fail(location + ": " + message)
	}
	artifact.warn(inner.warnings...)
	count := len(candidates)
	if mapping != nil {
		count++
	}
	if count > int(artifact.limits[0]) {
		artifact.fail(fmt.Sprintf("Unity symbols artifact contains %d symbol files; maximum is %d", count, artifact.limits[0]))
		mapping = nil
	} else {
		for index, candidate := range candidates {
			native = artifact.elfFile(native, candidate, names[index], map[string]any{"symbolFormat": "elf"})
		}
	}
	native = artifact.dedupe(native, "Unity native symbol")
	if count == 0 {
		artifact.fail("Unity symbols artifact contains no .so files or " + unityMappingName)
	}
	return buildID, native, mapping
}

func unityBuildID(data []byte) (string, string) {
	value := pyStrip(string(data))
	switch {
	case !utf8.Valid(data):
		return "", "Unity build_id must be UTF-8 text"
	case value == "":
		return "", "Unity build_id file is empty"
	case !unityBuildIDPattern.MatchString(value):
		return "", "Unity build_id must be 1-128 ASCII letters, numbers, dot, underscore, colon, or dash"
	}
	return value, ""
}

func il2cppMapping(location string, size int64, head []byte) (map[string]any, string) {
	switch trimmed := strings.TrimLeft(string(head), " \t\n\r\v\f"); {
	case size == 0:
		return nil, "IL2CPP mapping file is empty"
	case strings.Contains(string(head), "\x00"):
		return nil, "IL2CPP mapping file must be text JSON"
	case !strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "["):
		return nil, "IL2CPP mapping file must be JSON object or array data"
	}
	return map[string]any{"path": location, "byteSize": size, "symbolFormat": "il2cpp_mapping",
		"fileName": unityMappingName}, ""
}

// dedupe keeps one symbol file per identity, preferring richer symbols.
func (artifact *nativeArtifact) dedupe(files []map[string]any, label string) []map[string]any {
	kept, order := map[string]map[string]any{}, []string{}
	for _, file := range files {
		identity := fmt.Sprint(file["pdbDebugId"])
		switch {
		case file["elfClass"] != nil:
			for _, key := range []string{"fileSha256", "goBuildId", "gnuBuildId"} {
				if value, found := file[key]; found {
					identity = fmt.Sprint(file["arch"], ":", value)
				}
			}
		case file["guid"] != nil:
			identity = fmt.Sprint(file["guid"], "_", file["age"])
		}
		existing, found := kept[identity]
		if !found {
			kept[identity], order = file, append(order, identity)
			continue
		}
		reason := "skipping this file"
		if symbolSourcePriorities[file["symbolSource"]] > symbolSourcePriorities[existing["symbolSource"]] {
			kept[identity], reason = file, "keeping this file because it has richer symbols"
		} else if file["elfClass"] == nil {
			reason += " because " + existing["path"].(string) + " is at least as complete"
		}
		artifact.warn(fmt.Sprintf("%s: duplicate %s identity %s; %s", file["path"], label, identity, reason))
	}
	deduped := []map[string]any{}
	for _, identity := range order {
		deduped = append(deduped, kept[identity])
	}
	slices.SortStableFunc(deduped, func(left, right map[string]any) int {
		return strings.Compare(left["path"].(string), right["path"].(string))
	})
	return deduped
}

func nativeArchitectures(files []map[string]any) []string {
	architectures := []string{}
	for _, file := range files {
		architectures = append(architectures, file["arch"].(string))
	}
	slices.Sort(architectures)
	return slices.Compact(architectures)
}

// nativeWalk lists everything below a directory in pathlib's sorted order.
func nativeWalk(directory string) []string {
	found := []string{}
	_ = filepath.WalkDir(directory+"/", func(path string, _ fs.DirEntry, err error) error {
		if err == nil && path != directory+"/" {
			found = append(found, path)
		}
		return nil
	})
	return found
}

// nativeFiles lists the regular files of an artifact, except names that skip
// rejects.
func nativeFiles(path string, skip func(string) bool) []string {
	candidates := []string{path}
	if !nativeRegular(path) {
		candidates = nativeWalk(path)
	}
	return slices.DeleteFunc(candidates, func(candidate string) bool {
		return !nativeRegular(candidate) || skip != nil && skip(filepath.Base(candidate))
	})
}

func nativeRegular(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func nativeSize(path string) int64 {
	if info, err := os.Stat(path); err == nil {
		return info.Size()
	}
	return 0
}

func nativeSHA256(path string) string {
	file, closer := openNativeFile(path)
	defer closer()
	digest := sha256.New()
	_, _ = io.Copy(digest, io.NewSectionReader(file, 0, file.size))
	return hex.EncodeToString(digest.Sum(nil))
}

// pySuffix returns a file name's suffix the way Python's pathlib does.
func pySuffix(path string) string {
	name := filepath.Base(path)
	index := strings.LastIndex(name, ".")
	if index <= 0 || index == len(name)-1 {
		return ""
	}
	return name[index:]
}

func pathBase(name string) string { return name[strings.LastIndex(name, "/")+1:] }

// pyUTF8 decodes like Python's bytes.decode("utf-8", "replace"), which
// replaces each maximal invalid subsequence with one U+FFFD.
func pyUTF8(data []byte) string {
	var text strings.Builder
	for len(data) > 0 {
		character, width := utf8.DecodeRune(data)
		if character == utf8.RuneError && width == 1 {
			lead, need, low, high := data[0], 0, byte(0x80), byte(0xbf)
			switch {
			case lead >= 0xc2 && lead <= 0xdf:
				need = 1
			case lead >= 0xe0 && lead <= 0xef:
				need = 2
			case lead >= 0xf0 && lead <= 0xf4:
				need = 3
			}
			switch lead {
			case 0xe0:
				low = 0xa0
			case 0xed:
				high = 0x9f
			case 0xf0:
				low = 0x90
			case 0xf4:
				high = 0x8f
			}
			for width <= need && width < len(data) && data[width] >= low && data[width] <= high {
				width, low, high = width+1, 0x80, 0xbf
			}
		}
		text.WriteRune(character)
		data = data[width:]
	}
	return text.String()
}

// pySplitLines splits text at the line boundaries Python's str.splitlines uses.
func pySplitLines(text string) []string {
	lines := []string{}
	for text != "" {
		end := strings.IndexAny(text, "\n\r\v\f\x1c\x1d\x1e\u0085  ")
		if end < 0 {
			return append(lines, text)
		}
		_, width := utf8.DecodeRuneInString(text[end:])
		if strings.HasPrefix(text[end:], "\r\n") {
			width = 2
		}
		lines, text = append(lines, text[:end]), text[end+width:]
	}
	return lines
}
