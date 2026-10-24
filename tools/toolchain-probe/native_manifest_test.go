package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"iter"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

const symlinkPrefix = "symlink:"

func writeTempFile(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func mapKeys[V any](values map[string]V) iter.Seq[string] { return maps.Keys(values) }

// writeArtifacts writes files below root; a name ending in "/" is a directory
// and content starting with symlinkPrefix makes a symbolic link.
func writeArtifacts(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		var err error
		switch {
		case strings.HasSuffix(name, "/"):
			err = os.MkdirAll(path, 0o700)
		case strings.HasPrefix(content, symlinkPrefix):
			err = os.Symlink(strings.TrimPrefix(content, symlinkPrefix), path)
		default:
			err = os.WriteFile(path, []byte(content), 0o600)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}

func runNativeManifest(arguments ...string) (int, string, string) {
	var output, diagnostic bytes.Buffer
	code := checkReleaseArtifacts(append([]string{"native-manifest"}, arguments...), nil, &output, &diagnostic)
	return code, output.String(), diagnostic.String()
}

func manifestArguments(root string, extra ...string) []string {
	return append([]string{"--artifact-root", root, "--release", " 1.0 ", "--environment", "production", "--service",
		"app"}, extra...)
}

func TestNativeManifestArguments(t *testing.T) {
	root := t.TempDir()
	writeArtifacts(t, root, map[string]string{"mapping.txt": "com.A -> a:\n"})
	for _, test := range []struct {
		arguments []string
		message   string
	}{
		{[]string{"--release", "1"}, nativeManifestUsage},
		{manifestArguments(root, "--artifact", "x=y", "extra"), nativeManifestUsage},
		{manifestArguments(root, "--artifact", "x=y", "--unknown"), nativeManifestUsage},
		{manifestArguments(root, "--artifact", "x=y", "--max-symbol-files", "0"), nativeManifestUsage},
		{manifestArguments(root, "--artifact", "x=y", "--max-artifact-bytes", "x"), nativeManifestUsage},
		{manifestArguments(root), nativeManifestUsage},
		{manifestArguments(root, "--artifact", "ios_dsym"), "manifest validation failed: artifact must use TYPE=PATH syntax\n"},
		{manifestArguments(root, "--artifact", "x=y"), "manifest validation failed: unsupported artifact type: x; supported types: " +
			"ios_dsym, android_proguard_mapping, android_native_symbols, unity_symbols, breakpad_symbols, dotnet_pdb\n"},
		{manifestArguments(root, "--artifact", "ios_dsym= "), "manifest validation failed: artifact path is required\n"},
		{manifestArguments(root, "--artifact", "ios_dsym=x", "--service", "\u3000"), "manifest validation failed: service is required\n"},
		{manifestArguments(filepath.Join(root, "missing"), "--artifact", "ios_dsym=x"),
			"manifest validation failed: artifact root does not exist: " + filepath.Join(root, "missing") + "\n"},
		{manifestArguments(root, "--artifact", "ios_dsym=.//../x"),
			"manifest validation failed: artifact path must stay inside artifact root: ../x\n"},
	} {
		if code, output, diagnostic := runNativeManifest(test.arguments...); code != exitUsage || output != "" || diagnostic != test.message {
			t.Errorf("%v = %d, %q, %q", test.arguments, code, output, diagnostic)
		}
	}
	code, output, _ := runNativeManifest(manifestArguments(root, "--artifact", " android_proguard_mapping = mapping.txt",
		"--repository-url", "https://example.test/repo", "--commit-sha", " abc ", "--max-symbol-files", "1_0")...)
	var manifest map[string]any
	if err := json.Unmarshal([]byte(output), &manifest); err != nil || code != exitOK {
		t.Fatalf("manifest = %d, %v, %s", code, err, output)
	}
	artifact := manifest["artifacts"].([]any)[0].(map[string]any)
	if manifest["release"] != "1.0" || manifest["git"].(map[string]any)["commitSha"] != "abc" ||
		manifest["limits"].(map[string]any)["maxSymbolFiles"] != 10.0 || artifact["path"] != "mapping.txt" ||
		artifact["artifactId"] != "lbw_android_proguard_mapping_"+artifact["artifactSha256"].(string)[:32] ||
		!strings.HasSuffix(output, "}\n") || !strings.Contains(output, "\n  \"artifactType\": ") {
		t.Fatalf("manifest = %s", output)
	}
}

// nativeCase writes files, runs one artifact, and expects every needle in the
// printed manifest.
type nativeCase struct {
	files    map[string]string
	artifact string
	extra    []string
	needles  []string
}

func runNativeCases(t *testing.T, cases []nativeCase) {
	t.Helper()
	for _, test := range cases {
		root := t.TempDir()
		writeArtifacts(t, root, test.files)
		arguments := manifestArguments(root, append([]string{"--artifact", test.artifact}, test.extra...)...)
		code, output, diagnostic := runNativeManifest(arguments...)
		if code == exitUsage {
			t.Errorf("%s: %s", test.artifact, diagnostic)
		}
		for _, needle := range test.needles {
			if !strings.Contains(output, needle) {
				t.Errorf("%s: missing %q in\n%s", test.artifact, needle, output)
			}
		}
	}
}

func TestNativeManifestDsym(t *testing.T) {
	plist := "a.dSYM/Contents/Info.plist"
	dwarf := "a.dSYM/Contents/Resources/DWARF/"
	member := func(name string) string { return "P/" + name }
	runNativeCases(t, []nativeCase{
		{map[string]string{plist: "<plist/>", dwarf + "A": string(uuidMacho()),
			dwarf + "B": string(fatFixture(binary.BigEndian, false, uuidMacho(), uuidMacho()))}, "ios_dsym=a.dSYM",
			nil, []string{`"status": "ready"`, `"uuidCount": 3`, `"hasInfoPlist": true`, `"bundleName": "a.dSYM"`}},
		{nil, "ios_dsym=a.dSYM", nil, []string{"a.dSYM: dSYM bundle is missing"}},
		{map[string]string{"a.dSYM": "x"}, "ios_dsym=a.dSYM", nil, []string{"must be a .dSYM directory or .zip archive"}},
		{map[string]string{"a.dsym/": ""}, "ios_dsym=a.dsym", nil, []string{"dSYM artifact directory must end with .dSYM",
			`"hasInfoPlist": false`}},
		{map[string]string{"a.dSYM/": ""}, "ios_dsym=a.dSYM", nil, []string{"dSYM bundle is missing Contents/Resources/DWARF",
			"dSYM Info.plist is missing"}},
		{map[string]string{dwarf: ""}, "ios_dsym=a.dSYM", nil, []string{"dSYM DWARF directory has no object files"}},
		{map[string]string{dwarf + "A": "", dwarf + "B/": "", dwarf + "C": "abc"}, "ios_dsym=a.dSYM", nil,
			[]string{"a.dSYM/Contents/Resources/DWARF/A: DWARF object file is empty",
				"a.dSYM/Contents/Resources/DWARF/C: Mach-O UUID was not found (Mach-O object is truncated)",
				"dSYM UUIDs were not found"}},
		{map[string]string{dwarf + "A": "a", dwarf + "B": "b"}, "ios_dsym=a.dSYM", []string{"--max-symbol-files", "1"},
			[]string{"dSYM DWARF directory contains 2 symbol files; maximum is 1"}},
		{map[string]string{dwarf + "A": string(uuidMacho()), "a.dSYM/link": symlinkPrefix + "Contents"}, "ios_dsym=a.dSYM",
			nil, []string{"symbolic links are not accepted in release artifacts: a.dSYM/link"}},
		{map[string]string{dwarf + "A": string(uuidMacho())}, "ios_dsym=a.dSYM", []string{"--max-artifact-bytes", "10"},
			[]string{"dSYM artifact is 68 bytes; maximum is 10 bytes"}},
		{map[string]string{"d.zip": string(zipFixture(t, zip.Deflate, member(dwarf+"A"), string(uuidMacho()), member(plist),
			"<plist/>"))}, "ios_dsym=d.zip", nil, []string{`"status": "ready"`, `"archiveFormat": "zip"`,
			`"path": "d.zip!P/a.dSYM/Contents/Resources/DWARF/A"`, `"bundleName": "a.dSYM"`}},
		{map[string]string{"d.ZIP": "junk"}, "ios_dsym=d.ZIP", nil, []string{"dSYM archive is not a valid ZIP file",
			`"bundleCount": 0`}},
		{map[string]string{"d.zip": string(zipFixture(t, zip.Store, "x/../a", "", "readme", ""))}, "ios_dsym=d.zip", nil,
			[]string{"dSYM archive contains unsafe entry paths", "dSYM archive contains no .dSYM bundles",
				"dSYM archive contains no DWARF object files"}},
		{map[string]string{"d.zip": string(zipFixture(t, zip.Store, dwarf+"A", "", "b.dSYM/Contents/Resources/DWARF/B",
			strings.Repeat("x", 20), "c.dSYM/Contents/Resources/DWARF/C", "wxyz"))}, "ios_dsym=d.zip",
			[]string{"--max-symbol-file-bytes", "10"}, []string{"d.zip!a.dSYM/Contents/Resources/DWARF/A: DWARF object file is empty",
				"d.zip!b.dSYM/Contents/Resources/DWARF/B: symbol file is 20 bytes; maximum is 10 bytes",
				"Mach-O UUID was not found (not a Mach-O object)", "dSYM UUIDs were not found", "dSYM Info.plist is missing",
				`"bundleCount": 3`}},
		{map[string]string{"d.zip": string(zipFixture(t, zip.Store, dwarf+"A", "a", dwarf+"B", "b"))}, "ios_dsym=d.zip",
			[]string{"--max-symbol-files", "1"}, []string{"dSYM archive contains 2 DWARF object files; maximum is 1"}},
		{map[string]string{"real.zip": string(zipFixture(t, zip.Store, dwarf+"A", "a")), "d.zip": symlinkPrefix + "real.zip"},
			"ios_dsym=d.zip", nil, []string{"symbolic links are not accepted in release artifacts: d.zip", `"archiveFormat": "zip"`}},
	})
}

func TestNativeManifestProguard(t *testing.T) {
	runNativeCases(t, []nativeCase{
		{map[string]string{"mapping.txt": "# c\ncom.A -> a:\r\n\u00a0xy\u2003->\u3000b:\x1c  void f() -> g\n"},
			"android_proguard_mapping=mapping.txt", nil, []string{`"classMappingCount": 2`, `"lineCount": 4`, `"status": "ready"`}},
		{nil, "android_proguard_mapping=mapping.txt", nil, []string{"ProGuard/R8 mapping file is missing"}},
		{map[string]string{"m/": ""}, "android_proguard_mapping=m", nil, []string{"ProGuard/R8 mapping artifact must be a file"}},
		{map[string]string{"m.map": ""}, "android_proguard_mapping=m.map", nil, []string{"ProGuard/R8 mapping file is empty",
			"conventionally named mapping.txt"}},
		{map[string]string{"mapping.txt": "\xe2\x82 -> b:\n"}, "android_proguard_mapping=mapping.txt", nil,
			[]string{"ProGuard/R8 mapping file has no class mapping entries"}},
		{map[string]string{"mapping.txt": "a -> b:"}, "android_proguard_mapping=mapping.txt", []string{"--max-symbol-file-bytes", "3"},
			[]string{"mapping.txt: symbol file is 7 bytes; maximum is 3 bytes", `"lineCount": 0`}},
		{map[string]string{"real.txt": "a -> b:", "mapping.txt": symlinkPrefix + "real.txt"}, "android_proguard_mapping=mapping.txt",
			nil, []string{"symbolic links are not accepted"}},
	})
}

func TestNativeManifestSymbols(t *testing.T) {
	little := binary.LittleEndian
	debug, code := elfSection{".debug_info", 1, []byte("d"), 1}, elfSection{".text", 1, []byte("c"), 1}
	goID := elfSection{".note.go.buildid", 7, elfNote(little, "Go\x00\x00", 4, []byte("id")), 4}
	dynamic := elfSection{".dynsym", 11, []byte("s"), 1}
	pdb := portablePDB(fixtureGUID, 42)
	codeview := []any{2, codeView(fixtureGUID, 42, fixturePDBPath)}
	other := []any{2, codeView("FFEEDDCC-BBAA-9988-7766-554433221100", 1, "other.pdb")}
	own := []any{2, codeView(fixtureGUID, 3, "f.pdb")}
	runNativeCases(t, []nativeCase{
		{map[string]string{"s/a/lib.so": string(androidELF()), "s/b/lib.so": string(androidELF()), "s/c.txt": "x",
			"s/go.so": string(elfFixture(true, little, 62, goID, dynamic)), "s/sha.so": string(elfFixture(false, little, 3, code, debug))},
			"android_native_symbols=s", nil, []string{`"status": "ready"`, "s/b/lib.so: duplicate Android native symbol identity " +
				"arm64-v8a:32cc7f54; skipping this file", "only dynamic symbols found", "no ELF build ID found; dry run falls back",
				`"goBuildId": "id"`, `"x86"`}},
		{map[string]string{"s/a.so": string(elfFixture(true, little, 183, goID, dynamic)), "s/b.so": string(elfFixture(true, little, 183, goID, debug))},
			"android_native_symbols=s", nil, []string{"s/b.so: duplicate Android native symbol identity arm64-v8a:id; keeping this " +
				"file because it has richer symbols"}},
		{map[string]string{"lib.txt": string(androidELF())}, "android_native_symbols=lib.txt", nil, []string{`"symbolFileCount": 1`}},
		{nil, "android_native_symbols=s", nil, []string{"Android native symbols artifact is missing"}},
		{map[string]string{"s/": ""}, "android_native_symbols=s", nil, []string{"Android native symbols artifact contains no .so files"}},
		{map[string]string{"s/a.so": "", "s/b.so": "x", "s/c.so": string(patched(androidELF(), 16, 1)),
			"s/d.so": string(elfFixture(true, little, 99, debug)), "s/e.so": string(elfFixture(true, little, 183, debug)),
			"s/f.so": string(elfFixture(true, little, 183, code))}, "android_native_symbols=s", nil,
			[]string{"s/a.so: ELF file is empty", "s/b.so: not an ELF file", "s/c.so: unsupported ELF type unknown(1)",
				"s/d.so: unsupported ELF architecture unknown(99)", "s/e.so: ELF file has no build ID or code hash",
				"s/f.so: ELF file has no debug info or symbol tables"}},
		{map[string]string{"s/a.so": "abcd", "s/b.so": "a"}, "android_native_symbols=s", []string{"--max-symbol-file-bytes", "2"},
			[]string{"s/a.so: symbol file is 4 bytes; maximum is 2 bytes"}},
		{map[string]string{"b/a.sym": fixtureBreakpad, "b/b.sym": strings.Replace(fixtureBreakpad, "FILE", "PUBLIC", 1),
			"b/c.SYM": "x", "b/d.sym": "", "b/e.sym": "INFO\n", "b/f.sym": strings.Replace(fixtureBreakpad, "x86", "mips", 1)},
			"breakpad_symbols=b", nil, []string{"b/b.sym: duplicate Breakpad symbol identity " + fixtureDebugID +
				"; skipping this file because b/a.sym is at least as complete", "b/d.sym: Breakpad symbol file is empty",
				"b/e.sym: first non-empty line", "b/f.sym: Breakpad MODULE CPU is not mapped: mips", `"age": 42`}},
		{map[string]string{"x.SYM": fixtureBreakpad}, "breakpad_symbols=x.SYM", nil, []string{`"symbolFileCount": 1`}},
		{map[string]string{".sym": fixtureBreakpad}, "breakpad_symbols=.sym", nil, []string{"contains no .sym files"}},
		{map[string]string{"w/app.DLL": string(peFixture(0x20b, codeview)), "w/checkout.pdb": string(pdb),
			"w/b.exe": string(peFixture(0x10b, other)), "w/b.pdb": string(classicPDB("FFEEDDCC-BBAA-9988-7766-554433221100", 1, 0)),
			"w/c.dll": string(peFixture(0x20b, codeview, []any{17, embeddedPDB(pdb, len(pdb))})), "w/notes.txt": "x"},
			"dotnet_pdb=w", nil, []string{`"status": "ready"`, "w/c.dll: duplicate PDB symbol identity " + fixtureDebugID +
				"; skipping this file because w/app.DLL is at least as complete", `"pdbPath": "w/checkout.pdb"`,
				`"pdbPath": "w/b.pdb"`, `"pdbFormat": "windows_pdb"`}},
		{map[string]string{"w/c.dll": string(peFixture(0x20b, codeview, []any{17, embeddedPDB(pdb, len(pdb))}))}, "dotnet_pdb=w", nil,
			[]string{`"pdbFormat": "embedded_portable_pdb"`, `"pdbEmbeddedCompressedByteSize": `}},
		{map[string]string{"w/a.dll": "", "w/b.dll": "MZ", "w/c.dll": string(patched(peFixture(0x20b, codeview), 0x84, 1, 2)),
			"w/d.dll": string(peFixture(0x20b, other)), "w/other.pdb": "", "w/e.dll": string(peFixture(0x20b, codeview, []any{17,
				embeddedPDB(portablePDB(fixtureGUID, 7), len(pdb))})), "w/f.exe": string(peFixture(0x20b, own)),
			"w/f.pdb": "junk"}, "dotnet_pdb=w", nil, []string{"w/a.dll: PE file is empty", "w/b.dll: PE DOS header is truncated",
			"w/c.dll: PE machine architecture is not mapped: unknown(513)", "w/c.dll: associated PDB file was not found",
			"w/other.pdb: PDB file is empty", "w/e.dll: embedded Portable PDB debug ID " + fixtureGUID + "_7 does not match",
			"w/f.pdb: PDB payload format is not recognized"}},
		{map[string]string{"w/a.dll": string(peFixture(0x20b, codeview)), "w/a.pdb": string(pdb[:20])}, "dotnet_pdb=w", nil,
			[]string{"w/a.pdb: Portable PDB metadata root is truncated"}},
		{map[string]string{"w/a.dll": string(peFixture(0x20b, codeview)), "w/a.pdb": string(portablePDB(fixtureGUID, 1))},
			"dotnet_pdb=w", nil, []string{"w/a.pdb: Portable PDB debug ID " + fixtureGUID + "_1 does not match"}},
		{map[string]string{"w/a.dll": string(peFixture(0x20b, codeview)), "w/a.pdb": string(classicPDB(fixtureGUID, 1, 1))},
			"dotnet_pdb=w", nil, []string{"w/a.pdb: Windows PDB debug ID " + fixtureGUID + "_1 does not match"}},
		{map[string]string{"w/a.dll": string(peFixture(0x20b, codeview)), "w/a.pdb": string(classicPDB(fixtureGUID, 42, 42))},
			"dotnet_pdb=w", []string{"--max-symbol-file-bytes", "2000"}, []string{"w/a.pdb: symbol file is 6144 bytes"}},
		{map[string]string{"w/a.dll": string(peFixture(0x20b, codeview)), "w/a.pdb": string(pdb)}, "dotnet_pdb=w/a.dll", nil,
			[]string{`"status": "ready"`}},
	})
}

func TestNativeManifestUnity(t *testing.T) {
	mapping, elf := `{"files": []}`, string(androidELF())
	runNativeCases(t, []nativeCase{
		{map[string]string{"u/build_id": " checkout-1\n", "u/LineNumberMappings.json": mapping, "u/arm64/lib.so": elf,
			"u/x86/lib.so": elf}, "unity_symbols=u", nil, []string{`"status": "ready"`, `"buildId": "checkout-1"`,
			`"il2cppMappingFileCount": 1`, `"symbolFormat": "elf"`, "duplicate Unity native symbol identity"}},
		{nil, "unity_symbols=u", nil, []string{"Unity symbols artifact is missing"}},
		{map[string]string{"u.txt": "x"}, "unity_symbols=u.txt", nil, []string{"must be a directory or .zip archive"}},
		{map[string]string{"u/": ""}, "unity_symbols=u", nil, []string{"Unity symbols artifact is missing build_id",
			"contains no .so files or LineNumberMappings.json", "LineNumberMappings.json is missing"}},
		{map[string]string{"u/build_id": "\xff", "u/LineNumberMappings.json": "\x00", "u/lib.so": "x"}, "unity_symbols=u", nil,
			[]string{"u/build_id: Unity build_id must be UTF-8 text", "u/LineNumberMappings.json: IL2CPP mapping file must be text JSON",
				"u/lib.so: not an ELF file"}},
		{map[string]string{"u/build_id": "abcdef", "u/LineNumberMappings.json": "abcdef"}, "unity_symbols=u",
			[]string{"--max-symbol-file-bytes", "3"}, []string{"u/build_id: build_id file is 6 bytes; maximum is 3 bytes",
				"u/LineNumberMappings.json: symbol file is 6 bytes", "LineNumberMappings.json is missing"}},
		{map[string]string{"u/build_id": "bad id", "u/LineNumberMappings.json": " x"}, "unity_symbols=u", nil,
			[]string{"Unity build_id must be 1-128 ASCII letters", "IL2CPP mapping file must be JSON object or array data"}},
		{map[string]string{"u/build_id": " ", "u/LineNumberMappings.json": "", "u/a.so": elf}, "unity_symbols=u",
			[]string{"--max-symbol-files", "1"}, []string{"Unity build_id file is empty",
				"Unity symbols artifact contains 2 symbol files; maximum is 1"}},
		{map[string]string{"u/build_id": "b", "u/LineNumberMappings.json": ""}, "unity_symbols=u", nil,
			[]string{"IL2CPP mapping file is empty"}},
		{map[string]string{"u/build_id": "b", "u/link": symlinkPrefix + "build_id"}, "unity_symbols=u", nil,
			[]string{"symbolic links are not accepted in release artifacts: u/link"}},
		{map[string]string{"u.zip": string(zipFixture(t, zip.Deflate, "s/build_id", "b-1\n", "s/LineNumberMappings.json",
			"["+strings.Repeat(" ", 5000)+"]", "s/a.so", elf))}, "unity_symbols=u.zip", nil, []string{`"status": "ready"`,
			`"archiveFormat": "zip"`, `"path": "u.zip!s/a.so"`, `"buildId": "b-1"`, `"path": "u.zip!s/LineNumberMappings.json"`}},
		{map[string]string{"u.zip": "junk"}, "unity_symbols=u.zip", nil, []string{"u.zip: Unity symbols archive is not a valid ZIP file",
			"Unity symbols artifact contains no .so files or LineNumberMappings.json"}},
		{map[string]string{"u.zip": string(zipFixture(t, zip.Store, "a/build_id", "", "b/build_id", "", "a/LineNumberMappings.json",
			"", "b/LineNumberMappings.json", "", "../x", ""))}, "unity_symbols=u.zip", nil,
			[]string{"u.zip: Unity symbols archive contains unsafe entry paths", "contains multiple build_id files",
				"contains multiple LineNumberMappings.json files"}},
		{map[string]string{"u.zip": string(zipFixture(t, zip.Store, "a.so", "x"))}, "unity_symbols=u.zip", nil,
			[]string{"u.zip: Unity symbols archive is missing build_id", "LineNumberMappings.json is missing", "u.zip!a.so: not an ELF file"}},
		{map[string]string{"u.zip": string(zipFixture(t, zip.Store, "build_id", "bad id", "LineNumberMappings.json", "x",
			"a.so", "abcdef"))}, "unity_symbols=u.zip", []string{"--max-symbol-file-bytes", "5"},
			[]string{"u.zip: u.zip!build_id: build_id file is 6 bytes", "u.zip: u.zip!LineNumberMappings.json: IL2CPP mapping file must " +
				"be JSON", "u.zip: u.zip!a.so: symbol file is 6 bytes"}},
		{map[string]string{"u.zip": string(zipFixture(t, zip.Store, "build_id", "bad i", "LineNumberMappings.json", "abcdef"))},
			"unity_symbols=u.zip", []string{"--max-symbol-file-bytes", "5"}, []string{"u.zip: u.zip!build_id: Unity build_id must be",
				"u.zip: u.zip!LineNumberMappings.json: symbol file is 6 bytes"}},
		{map[string]string{"u.zip": string(zipFixture(t, zip.Store, "build_id", "b", "LineNumberMappings.json", "{}", "a.so", elf))},
			"unity_symbols=u.zip", []string{"--max-symbol-files", "1"}, []string{"Unity symbols artifact contains 2 symbol files; maximum is 1",
				`"il2cppMappingFileCount": 0`}},
		{map[string]string{"real.zip": "x", "u.zip": symlinkPrefix + "real.zip"}, "unity_symbols=u.zip", nil,
			[]string{"symbolic links are not accepted in release artifacts: u.zip"}},
	})
}

func TestNativeManifestStops(t *testing.T) {
	root := t.TempDir()
	broken := zipFixture(t, zip.Store, "a.dSYM/Contents/Resources/DWARF/A", "abcdef")
	broken[bytes.Index(broken, []byte("PK\x01\x02"))+16] ^= 1
	writeArtifacts(t, root, map[string]string{"fat.dSYM/Contents/Resources/DWARF/A": "\xca\xfe\xba\xbe\x00",
		"d.zip": string(broken)})
	for artifact, want := range map[string][2]any{
		"ios_dsym=fat.dSYM": {exitUsage, "manifest validation failed: file data is truncated\n"},
		"ios_dsym=d.zip":    {exitFailure, "cannot read ZIP member a.dSYM/Contents/Resources/DWARF/A\n"},
	} {
		code, output, diagnostic := runNativeManifest(manifestArguments(root, "--artifact", artifact)...)
		if code != want[0] || output != "" || diagnostic != want[1] {
			t.Errorf("%s = %d, %q, %q", artifact, code, output, diagnostic)
		}
	}
	func() {
		defer func() {
			if stop := recover().(nativeStop); stop.code != exitFailure {
				t.Fatalf("stop = %v", stop)
			}
		}()
		openNativeFile(filepath.Join(root, "missing"))
	}()
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, output, _ := runNativeManifest(manifestArguments(root, "--artifact", "dotnet_pdb=pipe")...); !strings.Contains(output,
		"PDB symbols artifact must be a .dll/.exe PE file or directory") {
		t.Fatalf("pipe = %s", output)
	}
	if nativeSize(filepath.Join(root, "missing")) != 0 {
		t.Fatal("missing file has a size")
	}
}
