package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Sensitive words are assembled so this file stays clean under the scan.
var (
	wordKey     = "sec" + "ret"
	wordPass    = "pass" + "word"
	wordArchive = "back" + "up"
	wordPutBack = "rest" + "ore"
	wordHost    = "host" + "name"
	wordRemote  = "s" + "sh"
	wordLookup  = "d" + "ns"
	archiveFlag = "isExcludedFrom" + strings.ToUpper(wordArchive[:1]) + wordArchive[1:]
)

func scanFixture(t *testing.T, files map[string]string, gitRepository bool) []string {
	t.Helper()
	root := t.TempDir()
	if gitRepository {
		if err := exec.Command("git", "init", "-q", root).Run(); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range files {
		writeFixtureFile(t, root, name, content)
	}
	rules, err := parseAllowRules(confidentialityRules)
	if err != nil {
		t.Fatal(err)
	}
	return confidentialityFailures(root, rules)
}

func writeFixtureFile(t *testing.T, root, name, content string) {
	t.Helper()
	target := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestConfidentialityRepositoryIsClean(t *testing.T) {
	t.Parallel()
	var output, diagnostic bytes.Buffer
	if code := checkConfidentiality([]string{"../.."}, &output, &diagnostic); code != exitOK ||
		output.String() != "confidentiality scan ok\n" {
		t.Fatalf("code %d: %s%s", code, output.String(), diagnostic.String())
	}
	// Every rule must still cover a file, so removed files take their rules along.
	rules, _ := parseAllowRules(confidentialityRules)
	files := scannedFiles("../..")
	for _, rule := range rules {
		if !slices.ContainsFunc(files, rule.path.MatchString) {
			t.Errorf("rule path %s matches no file", rule.path)
		}
	}
}

func TestConfidentialityReportsAndAllowsLines(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name    string
		files   map[string]string
		reports []string
	}{
		{"unexpected term", map[string]string{"docs/a.md": "ok\nthe " + wordKey + " value\n"},
			[]string{"./docs/a.md:2:the " + wordKey + " value"}},
		{"identifier boundaries", map[string]string{"a.txt": "x" + wordRemote + "\n" + wordRemote + "d\nuse " + wordRemote + "\n"},
			[]string{"./a.txt:3:use " + wordRemote}},
		{"exact rails fixture", map[string]string{"scripts/real_user_ruby_rails_smoke.sh": "  config." + wordKey +
			`_key_base = "installed-rails-smoke-` + wordKey + `-key-base"` + "\n# arbitrary " + wordKey + "\n"},
			[]string{"./scripts/real_user_ruby_rails_smoke.sh:2:# arbitrary " + wordKey}},
		{"tool matrix names", map[string]string{
			"quality/tool-matrix.toml": `uses = ["rubygems/configure-rubygems-cre` + `dentials"]` + "\n" +
				`commands = ["dotnet ` + wordPutBack + `", "rubygems/configure-rubygems-cre` + `dentials"]` + "\n" +
				`risk = "leaked cre` + `dentials"` + "\n",
			"other.toml": `commands = ["dotnet ` + wordPutBack + `"]` + "\n",
		}, []string{`./other.toml:1:commands = ["dotnet ` + wordPutBack + `"]`,
			`./quality/tool-matrix.toml:3:risk = "leaked cre` + `dentials"`}},
		{"archive exclusion symbol only", map[string]string{
			"swift/logbrew-swift/Sources/LogBrewCrash/CrashStorageDirectory.swift": "values." + archiveFlag +
				" = true\nvalues." + archiveFlag + " = " + wordArchive + "\n",
		}, []string{"./swift/logbrew-swift/Sources/LogBrewCrash/CrashStorageDirectory.swift:2:values." + archiveFlag + " = " +
			wordArchive}},
		{"path scoped queue word", map[string]string{
			"python/logbrew_py/src/logbrew_sdk/_rq_client.py": "_" + wordPutBack + "(worker)\n",
			"python/logbrew_py/src/logbrew_sdk/other.py":      "_" + wordPutBack + "(worker)\n",
		}, []string{"./python/logbrew_py/src/logbrew_sdk/other.py:1:_" + wordPutBack + "(worker)"}},
		{"term sets", map[string]string{
			"dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrewHttpClientFactoryCorrelation.cs": wordLookup + " " + wordHost +
				"\n" + wordLookup + " " + wordKey + "\n",
			"objc/logbrew-objc/README.md": wordArchive + " cleanup\n" + wordArchive + " " + wordPass + "\n",
			"go/logbrew/README.md":        wordLookup + "Start " + wordKey + "\n",
		}, []string{
			"./dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrewHttpClientFactoryCorrelation.cs:2:" + wordLookup + " " + wordKey,
			"./objc/logbrew-objc/README.md:2:" + wordArchive + " " + wordPass,
		}},
		{"brand images and skipped files", map[string]string{
			"assets/brand/logo.svg": wordKey + "\n", "LICENSE": wordKey + "\n", "node_modules/a.js": wordKey + "\n",
			"x.egg-info/a": wordKey + "\n", "empty.txt": "", "a.PNG": wordKey + "\n", "tools/toolchain-probe/confidentiality_scan.go": wordKey,
		}, nil},
		{"agent guide home paths", map[string]string{
			"AGENTS.md": "/" + "Users/name/project\n", "docs/AGENTS.override.md": "/" + "home/name/x\n",
			"docs/notes.md": "/" + "Users/name/project\n",
		}, []string{"./AGENTS.md:1:/" + "Users/name/project", "./docs/AGENTS.override.md:1:/" + "home/name/x"}},
		{"readme language", map[string]string{"js/README.md": "Install it.\nRun the smoke test.\n"},
			[]string{"./js/README.md:2:public README should describe LogBrew service integration, not SDK verification: " +
				"Run the smoke test."}},
		{"line breaks and encoding", map[string]string{"a.txt": "one\r\ntwo\rthree\vfour " + wordKey + "\xff\n"},
			[]string{"./a.txt:4:four " + wordKey}},
	} {
		if got := scanFixture(t, test.files, false); !slices.Equal(got, test.reports) {
			t.Fatalf("%s: %q, want %q", test.name, got, test.reports)
		}
	}
}

func TestConfidentialityPlanningFiles(t *testing.T) {
	t.Parallel()
	files := map[string]string{"plans/a.md": "x\n", "CLAUDE.md": "x\n", ".gitignore": "/plans/\n"}
	got := scanFixture(t, files, true)
	if len(got) != 1 || !strings.HasPrefix(got[0], "./CLAUDE.md: forbidden public planning file") {
		t.Fatalf("git checkout: %q", got)
	}
	if got := scanFixture(t, files, false); len(got) != 2 {
		t.Fatalf("plain tree: %q", got)
	}
}

func TestConfidentialityOrdersPathsLikeDirectories(t *testing.T) {
	t.Parallel()
	got := scanFixture(t, map[string]string{"a-b/x": wordKey, "a/b": wordKey, "a.txt": wordKey}, true)
	if !slices.Equal(got, []string{"./a/b:1:" + wordKey, "./a-b/x:1:" + wordKey, "./a.txt:1:" + wordKey}) {
		t.Fatalf("order %q", got)
	}
}

func TestAllowRuleKinds(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		rule, path, line string
		allowed          bool
	}{
		{"a/*.txt\t*\tline\tx " + wordKey, "a/b.txt", "  x " + wordKey + " ", true},
		{"a/*.txt\t*\tline\tx " + wordKey, "a/b/c.txt", "x " + wordKey, false},
		{"a/**/c.txt\t*\traw\tx " + wordKey, "a/c.txt", " x " + wordKey, false},
		{"a/**/c.txt\t*\traw\tx " + wordKey, "a/b/d/c.txt", "x " + wordKey, true},
		{"**\t*\tprefix\tlet", "x", "  let " + wordKey, true},
		{"**\t" + wordKey + "\thas\tKey", "x", "Key " + wordKey, true},
		{"**\t" + wordKey + "\thas\tKey", "x", "Key " + wordKey + " " + wordPass, false},
		{"**\t*\tihas\tthe key", "x", "The Key " + wordKey, true},
		{"{a,b}.py\t*\titem\t" + wordKey, "b.py", `  "` + wordKey + `",`, true},
		{"{a,b}.py\t*\titem\t" + wordKey, "c.py", `"` + wordKey + `",`, false},
		{"**\t<=" + wordKey + "," + wordLookup + "\tany\t-", "x", wordKey + " " + wordLookup, true},
		{"**\t<=" + wordKey + "," + wordLookup + "\tany\t-", "x", wordKey + " " + wordPass, false},
		{"**\t>=" + wordLookup + "\tany\t-", "x", wordLookup + " " + wordKey, true},
		{"**\t>=" + wordLookup + "\tany\t-", "x", wordKey, false},
		{"**\t*\tonly\tNoArchive", "x", "NoArchive", true},
		{"**\t*\tre\t^a+$", "x", "aaa", true},
	} {
		rule, valid := parseAllowRule(test.rule)
		if !valid {
			t.Fatalf("rule %q is invalid", test.rule)
		}
		if got := rule.allows(test.path, test.line, sensitiveTerms(test.line)); got != test.allowed {
			t.Fatalf("%q on %s %q: %v", test.rule, test.path, test.line, got)
		}
	}
	for _, invalid := range []string{"a\t*\tline", "\t*\tline\tx", "a\t*\tline\t", "a\t*\tnope\tx", "a\t*\tre\t(",
		"{a\t*\tline\tx"} {
		if _, valid := parseAllowRule(invalid); valid {
			t.Fatalf("rule %q is valid", invalid)
		}
	}
	if _, err := parseAllowRules("# note\n\nbad rule\n"); err == nil ||
		err.Error() != confidentialityAllowlist+":3: invalid rule" {
		t.Fatalf("error %v", err)
	}
}

func TestConfidentialityCommand(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeFixtureFile(t, root, "a.txt", wordKey+"\n")
	var output, diagnostic bytes.Buffer
	if code := checkConfidentiality([]string{root}, &output, &diagnostic); code != exitFailure ||
		output.String() != "./a.txt:1:"+wordKey+"\n" ||
		diagnostic.String() != "confidentiality scan found unexpected matches\n" {
		t.Fatalf("code %d: %q %q", code, output.String(), diagnostic.String())
	}
	if code := checkConfidentiality(nil, &output, &diagnostic); code != exitUsage {
		t.Fatalf("usage code %d", code)
	}
	closed, err := os.CreateTemp(t.TempDir(), "closed")
	if err != nil {
		t.Fatal(err)
	}
	_ = closed.Close()
	if code := checkConfidentiality([]string{root}, closed, &diagnostic); code != exitFailure {
		t.Fatalf("closed output code %d", code)
	}
}
