package main

import (
	"regexp"
	"strings"
	"testing"
)

func TestPatternMetadataDeclarations(t *testing.T) {
	t.Parallel()
	for _, policy := range []sourceMetadataPolicy{goMetadataPolicy(), rubyMetadataPolicy()} {
		for name, required := range policy.patterns {
			data := repositorySource(t, policy.prefix+name)
			for _, pattern := range required {
				compiled, err := regexp.Compile(pattern)
				if err != nil {
					t.Fatal(err)
				}
				changed := compiled.ReplaceAllString(data, "")
				if changed == data || validMetadataPatterns([]byte(changed), required) {
					t.Fatalf("%s required pattern mutation did not apply or was accepted", name)
				}
			}
		}
	}
}

func TestRubyMetadataWhitespace(t *testing.T) {
	t.Parallel()
	name := rubyMetadataPrefix + rubyMetadataManifest
	data := repositorySource(t, name)
	required := rubyMetadataPolicy().patterns[name]
	for _, space := range []string{
		"", " ", "\t", "\n", "\v", "\f", "\r", "\x1c\x1d\x1e\x1f",
		"\u0085", "\u00a0", "\u2003", "\u2028\u2029", "\u3000",
	} {
		changed := strings.NewReplacer(" = ", space+"="+space, " => ", space+"=>"+space,
			", LogBrew", ","+space+"LogBrew").Replace(data)
		if !validMetadataPatterns([]byte(changed), required) {
			t.Fatalf("documented metadata whitespace %q rejected", space)
		}
	}
	for _, invalid := range []string{
		strings.ReplaceAll(data, " = ", "\u200b=\u200b"),
		strings.ReplaceAll(data, " = ", "\u180e=\u180e"),
		strings.ReplaceAll(data, ">= 2.6", ">=\t2.6"),
	} {
		if validMetadataPatterns([]byte(invalid), required) {
			t.Fatal("non-whitespace separator or altered literal accepted")
		}
	}
}

func TestGoMetadataVersionPunctuation(t *testing.T) {
	t.Parallel()
	policy := goMetadataPolicy()
	name := "otel/" + goMetadataManifest
	data := repositorySource(t, policy.prefix+name)
	changed := strings.ReplaceAll(data, "v0.1.8", "v0x1x8")
	if changed == data || validMetadataPatterns([]byte(changed), policy.patterns[name]) {
		t.Fatal("Go dependency punctuation treated as regex wildcards")
	}
}

func TestMetadataPatternBounds(t *testing.T) {
	t.Parallel()
	for _, invalid := range []string{"", "x\xff", strings.Repeat("x", pythonManifestLimit+1)} {
		if validMetadataPatterns([]byte(invalid), []string{"x"}) {
			t.Fatal("empty, malformed, or oversized pattern input accepted")
		}
	}
	if validMetadataPatterns([]byte("x"), []string{"["}) {
		t.Fatal("invalid metadata pattern accepted")
	}
}

func TestPatternMetadataInventory(t *testing.T) {
	t.Parallel()
	const expectedPatterns = 20
	goPolicy, rubyPolicy := goMetadataPolicy(), rubyMetadataPolicy()
	if len(goPolicy.patterns) != 4 || len(goPolicy.files) != 4 || len(goPolicy.text) != 0 ||
		len(rubyPolicy.patterns) != 1 || len(rubyPolicy.files) != 5 || len(rubyPolicy.text) != 3 {
		t.Fatal("Go/Ruby metadata file inventory changed")
	}
	count := 0
	for _, policy := range []sourceMetadataPolicy{goPolicy, rubyPolicy} {
		for _, patterns := range policy.patterns {
			count += len(patterns)
		}
	}
	if count != expectedPatterns {
		t.Fatal("Go/Ruby required pattern inventory changed")
	}
}
