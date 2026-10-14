package main

import (
	"regexp"
	"strings"
)

const (
	rubyMetadataFamily   = "ruby"
	rubyMetadataPrefix   = "ruby/logbrew-ruby/"
	rubyMetadataManifest = "logbrew-sdk.gemspec"
	goMetadataModule     = "github.com/LogBrewCo/sdk/go/logbrew"
	goMetadataManifest   = "go.mod"
	metadataUnicodeSpace = `[[:space:]\p{Z}\x85\x1c-\x1f]`
)

func goMetadataPolicy() sourceMetadataPolicy {
	const moduleIdentityFields = 2
	policy := sourceMetadataPolicy{
		prefix: "go/logbrew/", files: nil, text: nil, patterns: make(map[string][]string),
	}
	for name, dependencies := range map[string][]string{
		"":       nil,
		"otel/":  {goMetadataModule + " v0.1.8", "go.opentelemetry.io/otel/sdk v1.41.0"},
		"gin/":   {goMetadataModule + " v0.1.7", "github.com/gin-gonic/gin v1.11.0"},
		"asynq/": {goMetadataModule + " v0.1.9", "github.com/hibiken/asynq v0.26.0"},
	} {
		module := strings.TrimSuffix(goMetadataModule+"/"+name, "/")
		patterns := make([]string, 0, moduleIdentityFields+len(dependencies))
		patterns = append(patterns, `(?m)^module `+regexp.QuoteMeta(module)+`$`, `(?m)^go 1\.24\.0$`)
		for _, dependency := range dependencies {
			patterns = append(patterns, regexp.QuoteMeta(dependency))
		}
		policy.patterns[name+goMetadataManifest] = patterns
		policy.files = append(policy.files, name+policyRootGuide)
	}
	return policy
}

func rubyMetadataPolicy() sourceMetadataPolicy {
	patterns := []string{
		`Gem::Specification\.new\("logbrew-sdk",\s*LogBrew::VERSION\)`,
		`spec\.license\s*=\s*"MIT"`, `spec\.authors\s*=\s*\["LogBrew"\]`,
		`spec\.homepage\s*=\s*"https://github\.com/LogBrewCo/sdk"`,
		`"source_code_uri"\s*=>\s*"https://github\.com/LogBrewCo/sdk"`,
		`spec\.required_ruby_version\s*=\s*">= 2\.6"`,
	}
	for index, pattern := range patterns {
		patterns[index] = strings.ReplaceAll(pattern, `\s`, metadataUnicodeSpace)
	}
	return sourceMetadataPolicy{
		prefix: "",
		files: []string{
			rubyMetadataPrefix + "lib/logbrew-sdk.rb", rubyMetadataPrefix + "lib/logbrew/rails.rb",
			rubyMetadataPrefix + "lib/logbrew/rails_integration.rb", rubyMetadataPrefix + "tests/rails_integration.rb",
			"scripts/real_user_ruby_rails_smoke.sh",
		},
		text: map[string][]string{
			rubyMetadataPrefix + rubyMetadataManifest:     {policyRootGuide, metadataExampleMakefile},
			rubyMetadataPrefix + "lib/logbrew/version.rb": {`VERSION = "0.1.14"`},
			rubyMetadataPrefix + policyRootGuide: {
				"Rails Quick Start", "LOGBREW_SERVER_API_KEY", "logbrew projects create rails-service",
				"logbrew doctor --project", "logbrew traces --project",
			},
		},
		patterns: map[string][]string{rubyMetadataPrefix + rubyMetadataManifest: patterns},
	}
}
